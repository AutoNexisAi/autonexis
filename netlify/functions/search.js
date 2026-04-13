const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
let ebayTokenCache = { token: null, expiresAt: 0 };

async function getEbayAccessToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET");
  }

  const now = Date.now();
  if (ebayTokenCache.token && ebayTokenCache.expiresAt > now + 60_000) {
    return ebayTokenCache.token;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: EBAY_SCOPE,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay auth failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  ebayTokenCache = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 7200) * 1000,
  };

  return ebayTokenCache.token;
}

function normalizeEbayItem(item) {
  const image = item.image?.imageUrl || null;
  const location = [item.itemLocation?.city, item.itemLocation?.stateOrProvince]
    .filter(Boolean)
    .join(", ");

  return {
    source: "ebay",
    id: item.itemId || item.legacyItemId || null,
    title: item.title || "Untitled listing",
    price: item.price?.value ? Number(item.price.value) : null,
    currency: item.price?.currency || "GBP",
    image,
    url: item.itemWebUrl || null,
    seller: item.seller?.username || null,
    condition: item.condition || null,
    location: location || null,
    raw: item,
  };
}

async function searchEbay(query, limit = 12) {
  const token = await getEbayAccessToken();

  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("filter", "priceCurrency:GBP");
  url.searchParams.set("sort", "price");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`eBay search failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const items = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
  return items.map(normalizeEbayItem);
}

/**
 * MarketCheck is optional here because public docs clearly describe the product
 * and auth model, but endpoint coverage for UK inventory depends on your plan.
 * Put your exact UK-capable endpoint into MARKETCHECK_SEARCH_URL once you get it.
 */
async function searchMarketCheck(query, limit = 12) {
  const apiKey = process.env.MARKETCHECK_API_KEY;
  const searchUrl = process.env.MARKETCHECK_SEARCH_URL;

  if (!apiKey || !searchUrl) {
    return [];
  }

  const url = new URL(searchUrl);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("rows", String(limit));
  url.searchParams.set("query", query);

  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MarketCheck search failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  const listings = data.listings || data.records || data.results || [];

  return listings.map((item) => ({
    source: "marketcheck",
    id: item.id || item.vin || item.listing_id || null,
    title:
      item.heading ||
      [item.year, item.make, item.model, item.trim].filter(Boolean).join(" ") ||
      "Untitled listing",
    price: item.price ? Number(item.price) : null,
    currency: item.currency || "GBP",
    image: item.media?.photo_links?.[0] || item.media?.photo_links?.[0]?.url || null,
    url: item.vdp_url || item.url || null,
    seller: item.dealer?.name || item.seller_name || null,
    condition: item.condition || null,
    location: [item.dealer?.city, item.dealer?.state].filter(Boolean).join(", ") || null,
    raw: item,
  }));
}

function scoreDeal(listing, comparablePrices) {
  if (!listing.price || comparablePrices.length < 3) {
    return { label: "Unknown", score: null };
  }

  const avg = comparablePrices.reduce((a, b) => a + b, 0) / comparablePrices.length;
  const ratio = listing.price / avg;

  if (ratio <= 0.9) return { label: "Great Deal", score: 90 };
  if (ratio <= 1.05) return { label: "Fair Price", score: 70 };
  return { label: "Overpriced", score: 45 };
}

function dedupeListings(listings) {
  const seen = new Map();

  for (const item of listings) {
    const key = `${(item.title || "").toLowerCase().trim()}|${item.price || ""}`;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

exports.handler = async (event) => {
  try {
    const query = (event.queryStringParameters?.q || "").trim();
    const limit = Math.min(Number(event.queryStringParameters?.limit || 12), 24);

    if (!query) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing q query parameter" }),
      };
    }

    const [ebayListings, marketcheckListings] = await Promise.all([
      searchEbay(query, limit),
      searchMarketCheck(query, limit),
    ]);

    const merged = dedupeListings([...marketcheckListings, ...ebayListings]);
    const prices = merged.map((x) => x.price).filter((x) => typeof x === "number");

    const enriched = merged.map((item) => ({
      ...item,
      deal: scoreDeal(item, prices),
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        query,
        count: enriched.length,
        results: enriched,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Search backend failed",
        details: error.message,
      }),
    };
  }
};