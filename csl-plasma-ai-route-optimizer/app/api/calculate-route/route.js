import { getRouteGroup, buildLegs, calculateRateTableCost, compareScenario, PLC_COORDS } from '../../../lib/routeMath.js';
import { fetchGeoapifyRoute } from '../../../lib/geoapify.js';

export async function POST(req) {
  try {
    const body = await req.json();
    const routeGroup = getRouteGroup(body.routeName || '');
    if (!routeGroup) return Response.json({ error: 'Route not found' }, { status: 404 });
    const proposedPLC = body.proposedPLC || routeGroup.currentEndpointPLC;
    const base = compareScenario({ routeGroup, proposedPLC, roadFactor: Number(body.roadFactor || 1.18) });
    let actual = null;
    if (body.useActualRoadRoutes && process.env.GEOAPIFY_API_KEY) {
      const orderedStops = routeGroup.stops;
      const waypoints = orderedStops.map(s => ({ lat: s.lat, lng: s.lng }));
      const dest = PLC_COORDS[proposedPLC];
      if (dest) waypoints.push({ lat: dest.lat, lng: dest.lng });
      const route = await fetchGeoapifyRoute({ waypoints, avoidTolls: body.tollPreference === 'avoid' });
      const chargeableMiles = route.distanceMiles || base.proposed.chargeableMiles;
      const cost = calculateRateTableCost({ chargeableMiles, weeklyCases: routeGroup.weeklyCases });
      actual = { chargeableMiles, timeHours: route.timeHours, ...cost };
    }
    return Response.json({ routeGroup, comparison: base, actualRoadRoute: actual, assumptions: { deadheadExcludedFromCost: true, collectionTrailer: '48 ft refrigerated only', casesPerPallet: 70 } });
  } catch (err) { return Response.json({ error: err.message }, { status: 500 }); }
}
