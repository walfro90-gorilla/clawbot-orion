export const runtime = "nodejs"

import { NextResponse } from "next/server"
import { readFileSync } from "fs"

const MANIFEST_PATH = "/opt/orion-public/manifest.json"
const DOWNLOAD_BASE = "http://209.50.63.149/download"

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-orion-api-key",
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

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
    }, { headers: { ...CORS, "Cache-Control": "public, max-age=300" } })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500, headers: CORS })
  }
}
