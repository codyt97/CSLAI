import { getDataSummary } from './dataSummary.js';
import { getInvoiceAudit } from './invoiceAuditMath.js';
import { getFuelSurchargeAudit } from './fuelSurchargeMath.js';
import { ASSUMPTIONS, groupRouteRecords } from './routeMath.js';

const REQUIREMENTS = {
  'Center master data': ['center number','center name','address','city','state','ZIP','latitude','longitude','active/open status','opening/closing status','assigned PLC','current route name','pickup days','Week A / Week B pattern','weekly pickup frequency','allowed pickup windows','dock/loading constraints','on-site storage capacity','cold-chain hold capacity','contact/escalation owner'],
  'Volume and demand data': ['weekly cases by center','weekly liters by center','weekly pallets by center','cases per pallet assumption','seasonality by center','peak week volume','off-peak week volume','12-month historical volume','forecasted volume','center growth/decline trend','minimum pickup frequency needed','maximum days plasma can remain on site'],
  'Shipment / BOL data': ['shipment ID','BOL number','invoice number','pickup date','pickup time','delivery date','delivery time','origin center','destination PLC','route name','actual stop sequence','planned stop sequence','cases shipped','pallets shipped','weight','temperature service type','trailer type','route frequency','weekly/monthly shipment count', 'true shipment count by week'],
  'Mileage and routing data': ['actual route miles','contract billable miles','deadhead miles','loaded miles','empty miles','PC Miler miles','Geoapify/scenario miles','GPS/telematics miles','stop-to-stop miles','center-to-PLC miles','route origin','route end location','relay/shuttle miles','toll miles','route duration','driver hours','dwell time per stop'],
  'Cost and invoice data': ['linehaul amount','fuel surcharge amount','BOL total','invoice total','accessorial charges','detention charges','layover charges','special pickup charges','pallet surcharge','toll charge','temperature-control surcharge','rate basis','rate per mile','rate per pound / CWT','minimum charge','fuel index used','fuel surcharge percent','invoice dispute deadline','overcharge/undercharge deadline'],
  'Contract and rate data': ['rate table','contract mileage rules','fuel surcharge formula', 'carrier rate logic','minimum charge rules','detention rules','trailer ordered/not-used rules','accessorial rules','dispute window','overcharge/undercharge window','equipment requirements','service-level requirements','routing guide rules'],
  'Carrier / operational performance data': ['carrier name','route assigned carrier','on-time pickup %','on-time delivery %','missed pickup count','late pickup count','temperature excursion count','claims/damages','rejected loads','driver issue logs','service failures', 'service performance','recovery actions','average dwell time','average route duration','asset utilization','trailer utilization','truck count','dedicated equipment count'],
  'RFQ modeling data': ['current baseline cost','current baseline miles','current baseline weekly cases','current baseline pallets','proposed scenario cost','proposed scenario miles','proposed route groups','proposed PLC assignments','proposed pickup frequency','proposed route count','proposed equipment count','scenario savings/opportunity','implementation risk','validation status','carrier pricing response','carrier assumptions','bid lane ID','bid route ID'],
  'Validation and governance data': ['source system','data owner','refresh frequency','last updated date','data quality score','missing field count','duplicate center flag','unmatched invoice flag','unmatched route flag','manual override flag','assumption flag','validation owner','sign-off status']
};

const CRITICAL_FIELDS = new Set(['true shipment count by week','shipment ID','actual route miles','contract billable miles','actual stop sequence','12-month historical volume','carrier rate logic','accessorial charges','fuel surcharge basis','service performance','route origin','route end location','driver hours','allowed pickup windows','on-site storage capacity','cold-chain hold capacity','weekly/monthly shipment count', 'true shipment count by week','pickup date','BOL number','linehaul amount','fuel surcharge amount','BOL total']);

function sourceFile(summary, fileName) {
  return (summary.files || []).find((file) => file.fileName === fileName) || {};
}

function statusForField(field, inventory) {
  const f = field.toLowerCase();
  if (/center number|center name|address|city|state|zip|latitude|longitude|active|assigned plc|current route|pickup days|week a|week b|weekly pickup frequency/.test(f)) return inventory.centersAvailable ? 'Available' : 'Missing';
  if (/weekly cases|weekly liters|weekly pallets|cases per pallet/.test(f)) return inventory.volumeAvailable ? 'Available' : 'Missing';
  if (/bol number|invoice number|pickup date|linehaul amount|fuel surcharge amount|bol total|invoice dispute|overcharge/.test(f)) return inventory.invoiceAuditAvailable ? 'Available' : 'Missing';
  if (/rate table|fuel surcharge formula|dispute window|overcharge/.test(f)) return inventory.contractRulesAvailable ? 'Partial' : 'Missing';
  if (/proposed scenario|scenario savings|implementation risk|validation status|proposed route/.test(f)) return inventory.optimizationAvailable ? 'Available' : 'Missing';
  if (/geoapify|scenario miles/.test(f)) return 'Available';
  if (/route origin|driver hours|route duration/.test(f)) return 'Partial';
  if (/shipment id|true shipment|weekly\/monthly shipment|actual route miles|contract billable miles|pc miler|gps|telematics|dwell|carrier|on-time|temperature excursion|claims|service failures|bid lane|bid route|sign-off/.test(f)) return 'Missing';
  return 'Needs Validation';
}

function priorityForField(field) {
  const f = field.toLowerCase();
  if ([...CRITICAL_FIELDS].some((critical) => f.includes(critical))) return 'Critical';
  if (/miles|cost|invoice|pickup|volume|route|plc|fuel|contract|frequency|driver|storage|cold-chain|carrier/.test(f)) return 'High';
  if (/owner|refresh|quality|forecast|seasonality|trend/.test(f)) return 'Medium';
  return 'Low';
}

function ownerForCategory(category, field) {
  const f = field.toLowerCase();
  if (/carrier|on-time|driver|telematics|gps|claims|service/.test(f)) return 'Carrier / McKesson operations';
  if (/invoice|bol|linehaul|fuel|accessorial|rate|contract|mileage/.test(f)) return 'McKesson / carrier billing';
  if (/center|storage|cold-chain|pickup windows|contact/.test(f)) return 'CSL center operations';
  if (/forecast|volume|growth|seasonality/.test(f)) return 'CSL supply chain / plasma planning';
  return category.includes('Validation') ? 'CSL governance / data owner' : 'CSL + McKesson joint RFQ team';
}

function reasonForField(field) {
  return `Supports RFQ lane definition, baseline validation, KPI accuracy, and optimization scenario evaluation for ${field}.`;
}

function riskForField(field, status) {
  if (status === 'Available') return 'Low risk; validate freshness and source owner.';
  if (status === 'Partial' || status === 'Needs Validation') return `RFQ can use directional analysis, but ${field} requires validation before final carrier pricing.`;
  return `Missing ${field} can prevent final RFQ pricing, route optimization proof, or scenario savings validation.`;
}

export function buildCurrentDataInventory() {
  const summary = getDataSummary();
  const invoice = getInvoiceAudit();
  const fuel = getFuelSurchargeAudit({ dieselAverage: 3.70 });
  const routes = groupRouteRecords({ openOnly: true });
  return {
    generatedAt: summary.generatedAt,
    centersAvailable: (sourceFile(summary, 'centers.json').recordCount || 0) > 0,
    scheduledCentersAvailable: (sourceFile(summary, 'scheduledCenters.json').recordCount || 0) > 0,
    weekAStops: sourceFile(summary, 'weekAStops.json').recordCount || 0,
    weekBStops: sourceFile(summary, 'weekBStops.json').recordCount || 0,
    volumeAvailable: routes.some((route) => route.weeklyCases > 0),
    invoiceAuditAvailable: invoice.totalRows > 0 && invoice.totalLinehaul > 0,
    fuelAuditAvailable: fuel.totalLinehaul > 0,
    contractRulesAvailable: (sourceFile(summary, 'contractRules.json').recordCount || 0) > 0 || (sourceFile(summary, 'rateTable.json').recordCount || 0) > 0,
    optimizationAvailable: routes.length > 0,
    routeGroupCount: routes.length,
    invoiceRows: invoice.totalRows,
    files: summary.files || [],
    assumptions: { casesPerPallet: ASSUMPTIONS.casesPerPallet, reefer48FootMaxPallets: ASSUMPTIONS.reefer48FootMaxPallets }
  };
}

export function buildRequiredRfqDataDictionary() {
  return Object.entries(REQUIREMENTS).flatMap(([category, fields]) => fields.map((field) => ({
    category,
    fieldName: field,
    required: priorityForField(field) === 'Critical' ? 'Required' : 'Recommended',
    priority: priorityForField(field),
    businessReason: reasonForField(field),
    kpiEnabled: /cost|miles|cases|pallets|fuel|driver|co2|frequency|on-time|claims|dwell|shipment/i.test(field) ? 'RFQ baseline and performance KPI' : 'Data governance and lane definition',
    optimizationEnabled: /route|plc|miles|frequency|cases|pallets|driver|storage|shipment|stop/i.test(field) ? 'Route optimization and scenario validation' : 'RFQ data readiness',
    owner: ownerForCategory(category, field),
    recommendedFormat: /date|time|updated/i.test(field) ? 'ISO date/time columns' : /count|cases|pallet|miles|cost|amount|percent|weight|hours/i.test(field) ? 'Numeric field in CSV/XLSX' : 'Text/reference field in CSV/XLSX',
    exampleValue: /date/i.test(field) ? '2026-01-15' : /miles/i.test(field) ? '842.4' : /cost|amount/i.test(field) ? '15770.47' : /plc/i.test(field) ? 'Dallas PLC' : 'Provided by source owner'
  })));
}

export function classifyDataGap(requirement, inventory = buildCurrentDataInventory()) {
  const status = statusForField(requirement.fieldName, inventory);
  return {
    ...requirement,
    currentStatus: status,
    currentSource: status === 'Available' ? 'runtime JSON / audit data' : status === 'Partial' ? 'partial runtime data / assumptions' : 'not available in current runtime data',
    riskIfMissing: riskForField(requirement.fieldName, status)
  };
}

export function compareCurrentDataToRfqRequirements() {
  const inventory = buildCurrentDataInventory();
  const requirements = buildRequiredRfqDataDictionary().map((req) => classifyDataGap(req, inventory));
  return { inventory, requirements };
}

export function scoreRfqReadiness(requirements) {
  const weights = { Critical: 5, High: 3, Medium: 2, Low: 1 };
  const statusScore = { Available: 1, Partial: 0.6, 'Needs Validation': 0.4, Missing: 0 };
  const totalWeight = requirements.reduce((sum, req) => sum + weights[req.priority], 0);
  const earned = requirements.reduce((sum, req) => sum + weights[req.priority] * statusScore[req.currentStatus], 0);
  const score = Math.round((earned / Math.max(1, totalWeight)) * 100);
  const band = score >= 90 ? 'RFQ ready' : score >= 75 ? 'Mostly ready, minor gaps' : score >= 50 ? 'Usable for directional analysis, not final RFQ' : 'Not RFQ ready';
  return { score, band };
}

export function buildRfqDataRequestList(requirements) {
  return requirements
    .filter((req) => req.currentStatus !== 'Available')
    .sort((a, b) => ['Critical','High','Medium','Low'].indexOf(a.priority) - ['Critical','High','Medium','Low'].indexOf(b.priority))
    .map((req, index) => ({
      askNumber: index + 1,
      recipient: req.owner,
      request: `Please provide ${req.fieldName}.`,
      reason: req.businessReason,
      formatNeeded: req.recommendedFormat,
      exampleField: req.exampleValue,
      priority: req.priority,
      category: req.category,
      riskIfMissing: req.riskIfMissing
    }));
}

export function explainRfqDataRequirement(fieldName) {
  const { requirements } = compareCurrentDataToRfqRequirements();
  return requirements.find((req) => req.fieldName.toLowerCase() === String(fieldName || '').toLowerCase()) || null;
}

export function buildRfqDataReadinessSummary() {
  const { inventory, requirements } = compareCurrentDataToRfqRequirements();
  const readiness = scoreRfqReadiness(requirements);
  const gaps = requirements.filter((req) => req.currentStatus === 'Missing' || req.currentStatus === 'Needs Validation');
  const criticalGaps = gaps.filter((req) => req.priority === 'Critical').slice(0, 25);
  const askList = buildRfqDataRequestList(requirements);
  return {
    generatedAt: new Date().toISOString(),
    readiness,
    inventory,
    requirements,
    criticalGaps,
    dataRequestList: askList,
    mckessonAskList: askList.filter((ask) => /McKesson|carrier/i.test(ask.recipient)).slice(0, 30),
    cslInternalAskList: askList.filter((ask) => /CSL/i.test(ask.recipient)).slice(0, 30),
    dataQualityWarnings: inventory.files.filter((file) => file.warning || file.sourceStatus !== 'source-parsed-json').slice(0, 25)
  };
}
