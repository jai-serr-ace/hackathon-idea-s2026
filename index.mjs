//remember to set GOOGLE_API_KEY in your environment before starting the server
console.log("hackathon-idea-s2026 is initialized");
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const ai = process.env.GOOGLE_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })
  : null;
const mapboxAccessToken = process.env.MAPBOX_ACCESS_TOKEN?.trim() || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseResultsJson(text = "") {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonSource = fencedMatch?.[1] ?? text;
  const trimmed = jsonSource.trim();
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  const candidate = arrayMatch?.[0] ?? trimmed;
  const parsed = JSON.parse(candidate);

  return Array.isArray(parsed) ? parsed : [];
}

function normalizeStore(store) {
  return {
    name: typeof store?.name === "string" ? store.name.trim() : "",
    description:
      typeof store?.description === "string" ? store.description.trim() : "",
    website: typeof store?.website === "string" ? store.website.trim() : "",
    phone: typeof store?.phone === "string" ? store.phone.trim() : "",
    address: typeof store?.address === "string" ? store.address.trim() : "",
    image: typeof store?.image === "string" ? store.image.trim() : "",
  };
}

function ensureStoreArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeStore);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function buildMapboxStaticImageUrl({
  longitude,
  latitude,
  zoom = 14,
  width = 800,
  height = 600,
  styleId = "streets-v12",
  addMarker = true,
}) {
  if (!mapboxAccessToken) {
    throw new Error("Missing MAPBOX_ACCESS_TOKEN. Set it before requesting static map images.");
  }

  const safeLongitude = clampNumber(longitude, -180, 180, 0);
  const safeLatitude = clampNumber(latitude, -85, 85, 0);
  const safeZoom = clampNumber(zoom, 0, 22, 14);
  const safeWidth = Math.round(clampNumber(width, 1, 1280, 800));
  const safeHeight = Math.round(clampNumber(height, 1, 1280, 600));
  const overlay = addMarker
    ? `pin-s+e54b4b(${safeLongitude},${safeLatitude})/`
    : "";

  return `https://api.mapbox.com/styles/v1/mapbox/${encodeURIComponent(
    styleId
  )}/static/${overlay}${safeLongitude},${safeLatitude},${safeZoom}/${safeWidth}x${safeHeight}?access_token=${encodeURIComponent(
    mapboxAccessToken
  )}`;
}

async function geocodePlaceQuery(query) {
  if (!mapboxAccessToken) {
    throw new Error("Missing MAPBOX_ACCESS_TOKEN. Set it before requesting static map images.");
  }

  const endpoint = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(
    query
  )}&limit=1&access_token=${encodeURIComponent(mapboxAccessToken)}`;
  const response = await fetch(endpoint);

  if (!response.ok) {
    throw new Error(`Mapbox geocoding request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const feature = payload?.features?.[0];
  const coordinates = feature?.geometry?.coordinates;

  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("No Mapbox geocoding results were found for that query.");
  }

  return {
    longitude: coordinates[0],
    latitude: coordinates[1],
    placeName: feature.properties?.full_address || feature.properties?.name || query,
  };
}

async function generateStores(prompt) {
  if (!ai) {
    throw new Error("Missing GOOGLE_API_KEY. Set it before starting the server.");
  }

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING },
            website: { type: Type.STRING },
            phone: { type: Type.STRING },
            address: { type: Type.STRING },
            image: { type: Type.STRING },
          },
          required: [
            "name",
            "description",
            "website",
            "phone",
            "address",
            "image",
          ],
          propertyOrdering: [
            "name",
            "description",
            "website",
            "phone",
            "address",
            "image",
          ],
        },
      },
    },
  });

  try {
    return ensureStoreArray(JSON.parse(response.text ?? "[]"));
  } catch (parseError) {
    console.warn(
      "Could not parse Gemini structured JSON, falling back to text parsing:",
      parseError
    );

    try {
      return ensureStoreArray(parseResultsJson(response.text ?? ""));
    } catch (fallbackError) {
      console.warn("Could not parse Gemini fallback JSON:", fallbackError);
      return [];
    }
  }
}

app.use(express.json());
app.use("/css", express.static(path.join(__dirname, "css")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.locals.escapeHtml = escapeHtml;

app.get("/", (_req, res) => {
  return res.render("home");
});

app.get("/results", async (req, res) => {
  if (!ai) {
    return res.status(500).send("Missing GOOGLE_API_KEY. Set it before starting the server.");
  }

  const search = req.query.prompt?.trim();

  if (!search) {
    return res.status(400).send("A prompt query parameter is required.");
  }

  const searchPrompt = `Search for "${search}" related independent stores in Monterey, Seaside, Sand City, Marina, and Carmel CA. Return the results in a JSON array with the following format: [{"name":"store name","description":"short description of the store","website":"store website url","phone":"phone if available","address":"physical address of the place","image":"an image of the place"}, ...]. If there are no results, return an empty array.`;

  try {
    const stores = await generateStores(searchPrompt);

    console.log("Expected results JSON:", JSON.stringify(stores, null, 2));

    return res.render("results", { search, stores });
  } catch (error) {
    console.error("Gemini results request failed:", error);
    return res.status(500).send("Gemini request failed.");
  }
});

app.get("/singleResult", async (_req, res) => {
  const prompt = `Pick one random independent store or local adventure-worthy spot in Monterey, CA. Return the result as a JSON array with exactly one object in this format: [{"name":"store name","description":"short description of the store","website":"store website url","phone":"phone if available","address":"physical address of the place","image":"an image of the place"}]. If there are no results, return an empty array.`;

  try {
    const stores = await generateStores(prompt);
    const store = stores[0] ?? null;

    console.log(
      "Expected single result JSON:",
      JSON.stringify(store ? [store] : [], null, 2)
    );

    return res.render("singleResult", { store });
  } catch (error) {
    console.error("Gemini single result request failed:", error);
    return res.status(500).send("Gemini request failed.");
  }
});

app.post("/api/gemini", async (req, res) => {
  if (!ai) {
    return res.status(500).json({
      error: "Missing GOOGLE_API_KEY. Set it before starting the server.",
    });
  }

  const prompt = req.body?.prompt?.trim();

  if (!prompt) {
    return res.status(400).json({
      error: "A prompt is required in the request body.",
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    return res.json({ text: response.text });
  } catch (error) {
    console.error("Gemini request failed:", error);
    return res.status(500).json({
      error: "Gemini request failed.",
    });
  }
});

app.get("/api/mapbox/static-image", async (req, res) => {
  if (!mapboxAccessToken) {
    return res.status(500).json({
      error: "Missing MAPBOX_ACCESS_TOKEN. Set it before requesting static map images.",
    });
  }

  const query = req.query.q?.trim();
  const styleId = req.query.style?.trim() || "streets-v12";
  const zoom = req.query.zoom;
  const width = req.query.width;
  const height = req.query.height;
  const addMarker = req.query.marker !== "false";

  try {
    let longitude = req.query.lng;
    let latitude = req.query.lat;
    let resolvedQuery = null;

    if (query) {
      const geocoded = await geocodePlaceQuery(query);
      longitude = geocoded.longitude;
      latitude = geocoded.latitude;
      resolvedQuery = geocoded.placeName;
    }

    if (longitude == null || latitude == null) {
      return res.status(400).json({
        error: "Provide either q for a place search or both lng and lat query parameters.",
      });
    }

    const imageUrl = buildMapboxStaticImageUrl({
      longitude,
      latitude,
      zoom,
      width,
      height,
      styleId,
      addMarker,
    });

    return res.json({
      imageUrl,
      coordinates: {
        lng: clampNumber(longitude, -180, 180, 0),
        lat: clampNumber(latitude, -85, 85, 0),
      },
      resolvedQuery,
    });
  } catch (error) {
    console.error("Mapbox static image request failed:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Mapbox static image request failed.",
    });
  }
});

app.listen(PORT, () => {
  if (!process.env.GOOGLE_API_KEY) {
    console.warn("GOOGLE_API_KEY is not set. /api/gemini will not work.");
  }

  if (!process.env.MAPBOX_ACCESS_TOKEN) {
    console.warn(
      "MAPBOX_ACCESS_TOKEN is not set. /api/mapbox/static-image will not work."
    );
  }

  console.log(`Server is running at http://localhost:${PORT}`);
});
