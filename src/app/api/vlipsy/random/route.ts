import { NextResponse } from "next/server";

const FALLBACK_KEY = "vl_hFxn07bG43d0n9t";
const API_BASE = "https://apiv2.vlipsy.com/v1/vlips";
const SEARCH_TERMS = ["meme", "funny", "reaction", "lol", "internet"];

type VlipsyItem = {
  media?: {
    mp4?: { url?: string };
    mp4_small?: { url?: string };
    preview_small?: { gif?: string; url?: string };
  };
  title?: string;
  from?: string;
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function GET() {
  const key = process.env.VLIPSY_API_KEY || FALLBACK_KEY;
  const term = pickRandom(SEARCH_TERMS);
  const limit = 25;

  try {
    const url = `${API_BASE}/search?q=${encodeURIComponent(term)}&key=${encodeURIComponent(key)}&limit=${limit}&safesearch=medium`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch Vlipsy content" }, { status: 502 });
    }

    const json = (await res.json()) as { data?: VlipsyItem[] };
    const items = (json.data ?? []).filter((item) => item.media?.mp4?.url || item.media?.mp4_small?.url);
    if (items.length === 0) {
      return NextResponse.json({ error: "No meme clips found" }, { status: 404 });
    }

    const clip = pickRandom(items);
    const videoUrl = clip.media?.mp4?.url || clip.media?.mp4_small?.url;
    const previewUrl = clip.media?.preview_small?.gif || clip.media?.preview_small?.url || "";

    return NextResponse.json({
      videoUrl,
      previewUrl,
      title: clip.title || "Random Meme",
      source: clip.from || "Vlipsy",
      term,
    });
  } catch {
    return NextResponse.json({ error: "Unexpected Vlipsy error" }, { status: 500 });
  }
}
