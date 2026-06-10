import { buildMaxSavingsScenario, buildScenarioBriefData, rankOptimizationScenarios } from '../../../lib/aiOptimizer.js';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') || 'Max Savings Optimization';
  const scenarioModes = ['Current Baseline', 'Conservative Optimization', 'Balanced Optimization', 'Max Savings Optimization'];
  const scenarios = rankOptimizationScenarios(scenarioModes.map((scenarioMode) => buildMaxSavingsScenario(scenarioMode)));
  const selected = scenarios.find((scenario) => scenario.scenarioType === mode) || scenarios[0];
  return Response.json({ scenarioModes, selected, scenarios, brief: buildScenarioBriefData(selected) });
}
