const GW = process.env.SWARM_GATEWAY_CONTROL || "http://127.0.0.1:9000";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await fetch(`${GW}/control/state`, { cache: "no-store" });
    return Response.json(await r.json());
  } catch (e: any) {
    return Response.json({ offline: true, error: e?.message || String(e) }, { status: 200 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body.action;
  const path = action === "record" ? "/control/record" : action === "keys" ? "/control/keys" : null;
  if (!path) return Response.json({ error: "unknown action" }, { status: 400 });
  try {
    const r = await fetch(`${GW}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.payload || {}),
    });
    return Response.json(await r.json());
  } catch (e: any) {
    return Response.json({ error: e?.message || String(e) }, { status: 502 });
  }
}
