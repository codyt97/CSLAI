import { fetchGeoapifyRoute } from '../../../lib/geoapify.js';
export async function POST(req) {
  if (!process.env.GEOAPIFY_API_KEY) {
    return Response.json({ error: 'GEOAPIFY_API_KEY is not configured' }, { status: 500 });
  }
  try {
    const body = await req.json();
    const result = await fetchGeoapifyRoute({ waypoints: body.waypoints, avoidTolls: body.avoidTolls, mode: body.mode || 'drive' });
    return Response.json(result);
  } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
}
