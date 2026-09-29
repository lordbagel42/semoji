BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE sources (
 name TEXT PRIMARY KEY, revision TEXT NOT NULL, canonical_name TEXT,
 image_url TEXT, source_json TEXT NOT NULL
);
CREATE INDEX sources_canonical ON sources(canonical_name);
CREATE TABLE analyses (
 name TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL,
 result_json TEXT NOT NULL,
 PRIMARY KEY(name, revision)
);
CREATE TABLE jobs (
 name TEXT PRIMARY KEY REFERENCES sources(name) ON DELETE CASCADE,
 revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','unknown')),
 lease_id TEXT UNIQUE, expires_at BIGINT, digest TEXT, error TEXT, updated_at BIGINT NOT NULL
);
CREATE INDEX jobs_pending ON jobs(updated_at,name) WHERE state='pending';
CREATE INDEX jobs_expiring ON jobs(expires_at) WHERE state='running';

-- Do not duplicate the full source/analysis payload in the search projection.
CREATE TABLE search_documents (
 name TEXT PRIMARY KEY REFERENCES sources(name) ON DELETE CASCADE,
 revision TEXT NOT NULL, vector_id TEXT NOT NULL UNIQUE,
 search_vector TSVECTOR NOT NULL
);
CREATE INDEX documents_search ON search_documents USING gin(search_vector);
CREATE TABLE embeddings (
 id TEXT PRIMARY KEY REFERENCES search_documents(vector_id) ON DELETE CASCADE,
 embedding HALFVEC(384) NOT NULL
);
CREATE INDEX embeddings_cosine ON embeddings USING hnsw(embedding halfvec_cosine_ops);
CREATE TABLE embedding_outbox (
 id TEXT PRIMARY KEY REFERENCES search_documents(vector_id) ON DELETE CASCADE
);
CREATE TABLE sync_state (
 id INTEGER PRIMARY KEY CHECK(id=1), dirty INTEGER NOT NULL DEFAULT 1,
 last_sync BIGINT NOT NULL DEFAULT 0
);
INSERT INTO sync_state(id) VALUES(1);

CREATE VIEW current_documents AS
 SELECT s.name, s.revision, substr(s.revision,1,32)||substr(coalesce(a.digest,s.revision),1,32) AS vector_id,
 s.source_json, a.result_json,
 s.name||' '||replace(replace(s.name,'_',' '),'-',' ')||' '||coalesce(
   replace(replace(a.name,'_',' '),'-',' ')||' '||concat_ws(' ',
     a.result_json::jsonb->'analysis'->>'summary',
     a.result_json::jsonb->'analysis'->>'description',
     (SELECT string_agg(value,' ') FROM jsonb_array_elements_text(
       (a.result_json::jsonb->'analysis'->'visibleText') || (a.result_json::jsonb->'analysis'->'subjects') ||
       (a.result_json::jsonb->'analysis'->'actions') || (a.result_json::jsonb->'analysis'->'emotions') ||
       (a.result_json::jsonb->'analysis'->'tags') || (a.result_json::jsonb->'analysis'->'usageExamples'))),
     a.result_json::jsonb->'analysis'->>'interpretation'),'') AS search_text,
 substr(s.name||' '||coalesce(a.result_json::jsonb->'analysis'->>'embeddingText',''),1,1800) AS embedding_text
 FROM sources s LEFT JOIN sources c ON c.name=s.canonical_name AND c.image_url=s.image_url
 LEFT JOIN analyses a ON a.name=c.name AND a.revision=c.revision
 WHERE s.canonical_name IS NULL OR c.name IS NOT NULL;

CREATE VIEW documents AS
 SELECT d.name,d.revision,d.vector_id,c.source_json,c.result_json,d.search_vector,c.embedding_text
 FROM search_documents d JOIN current_documents c ON c.name=d.name AND c.vector_id=d.vector_id;

CREATE FUNCTION refresh_documents(owner_name TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM search_documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=owner_name UNION SELECT owner_name);
 INSERT INTO search_documents(name,revision,vector_id,search_vector)
 SELECT name,revision,vector_id,to_tsvector('simple',search_text) FROM current_documents
 WHERE name IN (SELECT name FROM sources WHERE canonical_name=owner_name UNION SELECT owner_name);
END;
$$;

CREATE FUNCTION document_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO embedding_outbox(id) VALUES(new.vector_id);
 RETURN new;
END;
$$;
CREATE TRIGGER document_insert AFTER INSERT ON search_documents FOR EACH ROW EXECUTE FUNCTION document_insert();

CREATE FUNCTION source_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   DELETE FROM analyses WHERE name=old.name;
   PERFORM refresh_documents(old.name);
   RETURN old;
 END IF;
 IF TG_OP='UPDATE' AND old.revision=new.revision THEN RETURN new; END IF;
 DELETE FROM jobs WHERE name=new.name;
 INSERT INTO jobs(name,revision,state,updated_at)
 SELECT new.name,new.revision,'pending',(extract(epoch FROM clock_timestamp())*1000)::bigint
 WHERE new.canonical_name=new.name AND new.image_url IS NOT NULL;
 PERFORM refresh_documents(new.name);
 RETURN new;
END;
$$;
CREATE TRIGGER source_change AFTER INSERT OR UPDATE OF revision OR DELETE ON sources
 FOR EACH ROW EXECUTE FUNCTION source_change();

CREATE FUNCTION analysis_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM refresh_documents(new.name);
 RETURN new;
END;
$$;
CREATE TRIGGER analysis_change AFTER INSERT OR UPDATE ON analyses FOR EACH ROW EXECUTE FUNCTION analysis_change();
COMMIT;
