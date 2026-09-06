// push.send — sends a real, instant browser push notification (not an email, not a digest) to
// every subscription on file for one actor. First real piece of the approved alerting
// architecture (2026-09-06): "una notificacion donde yo le de ok y se ejecute... no me sirve un
// resumen." The notification's `data.url` is what the service worker (sw.js) opens on click — a
// small one-click confirm page for whatever action triggered it, not the whole app.
//
// Uses the standard `web-push` library (VAPID) — same protocol every browser's push service
// (Chrome/FCM, Firefox, Edge) speaks. Expired/unsubscribed endpoints (404/410 from the push
// service) are deleted here so the subscriptions table stays real, not a graveyard of dead
// browsers.

import postgres from "npm:postgres@3.4.4";
import webpush from "npm:web-push@3.6.7";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "title", "body"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, title, body: message, url = "/offers.html", actions = [] } = body;

    const subs = await sql`select * from push_subscriptions where actor = ${actor}`;
    if (!subs.length) return jsonResponse({ sent: 0, reason: "no_subscriptions_for_actor" });

    // actions: up to 2 {action, title, url} — real one-tap execute buttons on the notification
    // itself (e.g. "WhatsApp Planta"), not just a click that opens the app. sw.js reads
    // data.actionUrls to know where each button goes.
    const actionUrls: Record<string, string> = {};
    for (const a of actions) actionUrls[a.action] = a.url;
    const payload = JSON.stringify({
      title, body: message, url,
      actions: actions.map((a: any) => ({ action: a.action, title: a.title })),
      actionUrls,
    });
    let sent = 0;
    const deadEndpoints: string[] = [];

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        );
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) deadEndpoints.push(s.endpoint);
      }
    }));

    if (deadEndpoints.length) await sql`delete from push_subscriptions where endpoint = any(${deadEndpoints})`;

    return jsonResponse({ sent, total: subs.length, removed_expired: deadEndpoints.length });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
