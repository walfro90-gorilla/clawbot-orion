export const runtime = "nodejs"

import { NextResponse } from "next/server"
import { readFileSync } from "fs"

// Devuelve la versión actual deployada de la extension.
// Background.js de la extension la consulta cada hora para detectar updates.

const MANIFEST_PATH = "/opt/orion-public/manifest.json"
const DOWNLOAD_BASE = "http://209.50.63.149/download"

export async function GET() {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    return NextResponse.json({
      version:    manifest.version,
      tarballUrl: `${DOWNLOAD_BASE}/orion-extension.tar.gz`,
      installers: {
        windows: `${DOWNLOAD_BASE}/install-win.txt`,
        unix:    `${DOWNLOAD_BASE}/install-unix.txt`,
      },
    }, {
      headers: { "Cache-Control": "public, max-age=300" },  // 5 min cache
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
