-- 0009_company_brain — full-text search of the Company Brain (PHASE 08).
--
-- Expression GIN indexes, no new columns: the texts stay where they are and the queries of
-- @roi-dealer/database use exactly these expressions. English configuration: pains,
-- opportunities and evidence are English (forum posts and AI answers).

CREATE INDEX pains_search_idx ON pains USING gin (
  to_tsvector('english', title || ' ' || description || ' ' || audience || ' ' || desired_outcome)
);

CREATE INDEX opportunities_search_idx ON opportunities USING gin (
  to_tsvector('english', title || ' ' || summary || ' ' || icp || ' ' || value_problem || ' ' ||
    value_change || ' ' || value_measurable_result)
);

CREATE INDEX evidence_search_idx ON evidence USING gin (to_tsvector('english', excerpt));

CREATE INDEX knowledge_assets_search_idx ON knowledge_assets USING gin (
  to_tsvector('english', title || ' ' || summary || ' ' || coalesce(body, ''))
);

CREATE INDEX decisions_search_idx ON decisions USING gin (to_tsvector('english', rationale));
