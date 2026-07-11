// Maps each service a client can select to how it's actually fulfilled.
// This is the routing table described in the earlier planning: some
// services are served instantly from ingested data, some are
// semi-automated (live connector query), and most county/court work
// is manual for now.
//
// jurisdiction() is a function because several services are scoped
// per-subject (e.g. "Secretary of State, FL" is fixed) while others
// are scoped per-county and need the subject's county filled in.
const SERVICE_CATALOG = {
  certificate_of_status: {
    label: 'Certificate of Status',
    tier: 'instant',
    jurisdiction: () => 'Secretary of State, FL',
  },
  certified_articles: {
    label: 'Certified Articles',
    tier: 'semi_automated',
    jurisdiction: () => 'Secretary of State, FL',
  },
  ucc_search: {
    label: 'UCC Search',
    tier: 'semi_automated',
    jurisdiction: () => 'Secured Transaction Registry, FL',
  },
  similar_names_search: {
    label: 'Similar Names Search',
    tier: 'semi_automated',
    jurisdiction: () => 'Secured Transaction Registry, FL',
  },
  fed_state_lien_search: {
    label: 'Federal & State Lien Search',
    tier: 'semi_automated',
    jurisdiction: () => 'Secretary of State, FL',
  },
  county_recorder_search: {
    label: 'County Recorder Search',
    tier: 'manual',
    jurisdiction: (county) => `${county || 'Unspecified'} County Recorder, Clerk of the Circuit Court, FL`,
  },
  county_civil_docket_search: {
    label: 'County Civil Docket Search',
    tier: 'manual',
    jurisdiction: (county) => `${county || 'Unspecified'} County, Circuit & County Courts - Civil, FL`,
  },
  federal_court_bankruptcy_search: {
    label: 'Federal Court & Bankruptcy Search',
    tier: 'semi_automated', // PACER has a real API, unlike most county sites
    jurisdiction: () => 'US District & Bankruptcy Court, FL',
  },
};

// Given the subjects and selected service keys for an order, returns
// the flat list of search_request rows to insert — one per
// (subject x service), with jurisdiction resolved per subject's county
// where relevant.
function buildSearchMatrix(subjects, serviceKeys) {
  const rows = [];

  subjects.forEach((subject) => {
    serviceKeys.forEach((key) => {
      const service = SERVICE_CATALOG[key];
      if (!service) {
        throw new Error(`Unknown service key: ${key}`);
      }
      rows.push({
        subjectName: subject.name,
        serviceType: key,
        serviceLabel: service.label,
        jurisdiction: service.jurisdiction(subject.county),
        fulfillmentTier: service.tier,
      });
    });
  });

  return rows;
}

module.exports = { SERVICE_CATALOG, buildSearchMatrix };
