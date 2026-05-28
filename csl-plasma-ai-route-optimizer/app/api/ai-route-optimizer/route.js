import { runAiRouteOptimizer } from '../../../lib/aiOptimizer.js';
export async function POST(req) {
  try {
    const body = await req.json();
    const result = await runAiRouteOptimizer(body);
    return Response.json(result);
  } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
}
