export async function fetchGeoapifyRoute({ waypoints, avoidTolls = false, mode = 'drive' }) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) throw new Error('Missing GEOAPIFY_API_KEY');
  if (!Array.isArray(waypoints) || waypoints.length < 2) throw new Error('At least two waypoints are required');
  const waypointString = waypoints.map(p => `${p.lat},${p.lng}`).join('|');
  const params = new URLSearchParams({ waypoints: waypointString, mode, format: 'geojson', apiKey });
  if (avoidTolls) params.set('avoid', 'tolls');
  const res = await fetch(`https://api.geoapify.com/v1/routing?${params.toString()}`);
  if (!res.ok) throw new Error(`Geoapify failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const props = data?.features?.[0]?.properties || {};
  return {
    raw: data,
    distanceMiles: typeof props.distance === 'number' ? props.distance / 1609.344 : null,
    timeHours: typeof props.time === 'number' ? props.time / 3600 : null,
    properties: props
  };
}
