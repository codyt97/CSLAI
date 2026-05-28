import { fetchGeoapifyRoute } from '../../../lib/geoapify.js';
export async function POST(req) {
  try {
    const body = await req.json();
    const result = await fetchGeoapifyRoute({ waypoints: body.waypoints, avoidTolls: body.avoidTolls, mode: body.mode || 'drive' });
    return Response.json(result);
  } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
}
