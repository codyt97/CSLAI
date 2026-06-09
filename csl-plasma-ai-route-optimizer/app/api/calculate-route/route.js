import {
  getRouteGroup,
  calculateRateTableCost,
  compareScenario,
  PLC_COORDS
} from '../../../lib/routeMath.js';

import { fetchGeoapifyRoute } from '../../../lib/geoapify.js';

async function calculateActualRoadRoute({ routeGroup, endpointPLC, avoidTolls }) {
  const waypoints = routeGroup.stops.map((s) => ({
    lat: s.lat,
    lng: s.lng
  }));

  const dest = PLC_COORDS[endpointPLC];

  if (!dest || waypoints.length === 0) return null;

  waypoints.push({
    lat: dest.lat,
    lng: dest.lng
  });

  const route = await fetchGeoapifyRoute({
    waypoints,
    avoidTolls
  });

  const chargeableMiles = route.distanceMiles;

  const cost = calculateRateTableCost({
    chargeableMiles,
    weeklyCases: routeGroup.weeklyCases
  });

  return {
    endpointPLC,
    chargeableMiles,
    timeHours: route.timeHours,
    ...cost
  };
}

export async function POST(req) {
  try {
    const body = await req.json();

    const routeGroup = getRouteGroup(body.routeName || '');

    if (!routeGroup) {
      return Response.json(
        { error: 'Route not found' },
        { status: 404 }
      );
    }

    const proposedPLC = body.proposedPLC || routeGroup.currentEndpointPLC;

    const base = compareScenario({
      routeGroup,
      proposedPLC,
      roadFactor: Number(body.roadFactor || 1.18)
    });

    let actualCurrentRoadRoute = null;
    let actualProposedRoadRoute = null;
    let actualRoadComparison = null;

    if (body.useActualRoadRoutes && process.env.GEOAPIFY_API_KEY) {
      const avoidTolls = body.tollPreference === 'avoid';

      actualCurrentRoadRoute = await calculateActualRoadRoute({
        routeGroup,
        endpointPLC: routeGroup.currentEndpointPLC,
        avoidTolls
      });

      actualProposedRoadRoute = await calculateActualRoadRoute({
        routeGroup,
        endpointPLC: proposedPLC,
        avoidTolls
      });

      if (actualCurrentRoadRoute && actualProposedRoadRoute) {
        const weeklyCostSaved = Number(
          (actualCurrentRoadRoute.totalCost - actualProposedRoadRoute.totalCost).toFixed(2)
        );

        actualRoadComparison = {
          current: actualCurrentRoadRoute,
          proposed: actualProposedRoadRoute,
          savings: {
            weeklyMilesSaved: Number(
              (actualCurrentRoadRoute.chargeableMiles - actualProposedRoadRoute.chargeableMiles).toFixed(2)
            ),
            weeklyCostSaved,
            annualCostSaved: Number((weeklyCostSaved * 52).toFixed(2))
          }
        };
      }
    }

    return Response.json({
      routeGroup,
      comparison: base,
      actualCurrentRoadRoute,
      actualProposedRoadRoute,
      actualRoadComparison,
      assumptions: {
        deadheadExcludedFromCost: true,
        chargeStartsAt: 'first pickup',
        collectionTrailer: '48 ft refrigerated only',
        casesPerPallet: 70,
        reefer48FootMaxPallets: 24,
        importantFix: 'Current route miles are calculated as route-path miles, not summed stop-level weeklyMiles.'
      }
    });
  } catch (err) {
    return Response.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
