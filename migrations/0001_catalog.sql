CREATE TABLE sources (
 name TEXT PRIMARY KEY, revision TEXT NOT NULL, canonical_name TEXT,
 image_url TEXT, source_json TEXT NOT NULL, seen TEXT
);
CREATE INDEX sources_canonical ON sources(canonical_name);
CREATE TABLE analyses (
 name TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL,
 result_json TEXT NOT NULL, search_text TEXT NOT NULL, embedding_text TEXT NOT NULL,
 PRIMARY KEY(name, revision)
);
CREATE TABLE jobs (
 name TEXT PRIMARY KEY REFERENCES sources(name) ON DELETE CASCADE,
 revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','unknown')),
 lease_id TEXT UNIQUE, expires_at INTEGER, digest TEXT, error TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE documents (
 name TEXT PRIMARY KEY, revision TEXT NOT NULL, vector_id TEXT NOT NULL,
 source_json TEXT NOT NULL, result_json TEXT, search_text TEXT NOT NULL,
 embedding_text TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX documents_vector ON documents(vector_id);
CREATE VIRTUAL TABLE documents_fts USING fts5(name UNINDEXED, text);
CREATE TABLE embedding_outbox (id TEXT PRIMARY KEY, operation TEXT NOT NULL);
CREATE TABLE sync_state (
 id INTEGER PRIMARY KEY CHECK(id=1), dirty INTEGER NOT NULL DEFAULT 1,
 last_sync INTEGER NOT NULL DEFAULT 0, lock_id TEXT, lock_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_state(id) VALUES(1);

CREATE VIEW current_documents AS
 SELECT s.name, s.revision, substr(s.revision,1,32)||substr(coalesce(a.digest,s.revision),1,32) AS vector_id,
 s.source_json, a.result_json, s.name||' '||replace(replace(s.name,'_',' '),'-',' ')||' '||coalesce(a.search_text,'') AS search_text,
 substr(s.name||' '||coalesce(a.embedding_text,''),1,1800) AS embedding_text
 FROM sources s LEFT JOIN sources c ON c.name=s.canonical_name AND c.image_url=s.image_url
 LEFT JOIN analyses a ON a.name=c.name AND a.revision=c.revision
 WHERE s.canonical_name IS NULL OR c.name IS NOT NULL;

CREATE TRIGGER document_insert AFTER INSERT ON documents BEGIN
 INSERT INTO documents_fts(rowid,name,text) VALUES(new.rowid,new.name,new.search_text);
 INSERT INTO embedding_outbox VALUES(new.vector_id,'upsert') ON CONFLICT(id) DO UPDATE SET operation='upsert';
END;
CREATE TRIGGER document_delete AFTER DELETE ON documents BEGIN
 DELETE FROM documents_fts WHERE rowid=old.rowid;
 INSERT INTO embedding_outbox VALUES(old.vector_id,'delete') ON CONFLICT(id) DO UPDATE SET operation='delete';
END;
CREATE TRIGGER source_insert AFTER INSERT ON sources BEGIN
 INSERT INTO jobs(name,revision,state,updated_at) SELECT new.name,new.revision,'pending',unixepoch()*1000 WHERE new.canonical_name=new.name AND new.image_url IS NOT NULL;
 DELETE FROM documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=new.name);
 INSERT INTO documents(name,revision,vector_id,source_json,result_json,search_text,embedding_text) SELECT * FROM current_documents WHERE name=new.name OR name IN (SELECT name FROM sources WHERE canonical_name=new.name);
END;
CREATE TRIGGER source_update AFTER UPDATE OF revision ON sources WHEN old.revision<>new.revision BEGIN
 DELETE FROM jobs WHERE name=new.name;
 INSERT INTO jobs(name,revision,state,updated_at) SELECT new.name,new.revision,'pending',unixepoch()*1000 WHERE new.canonical_name=new.name AND new.image_url IS NOT NULL;
 DELETE FROM documents WHERE name=new.name OR name IN (SELECT name FROM sources WHERE canonical_name=new.name);
 INSERT INTO documents(name,revision,vector_id,source_json,result_json,search_text,embedding_text) SELECT * FROM current_documents WHERE name=new.name OR name IN (SELECT name FROM sources WHERE canonical_name=new.name);
END;
CREATE TRIGGER source_delete AFTER DELETE ON sources BEGIN
 DELETE FROM documents WHERE name=old.name OR name IN (SELECT name FROM sources WHERE canonical_name=old.name);
 INSERT INTO documents(name,revision,vector_id,source_json,result_json,search_text,embedding_text) SELECT * FROM current_documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=old.name);
 DELETE FROM analyses WHERE name=old.name;
END;
CREATE TRIGGER analysis_insert AFTER INSERT ON analyses BEGIN
 DELETE FROM documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=new.name);
 INSERT INTO documents(name,revision,vector_id,source_json,result_json,search_text,embedding_text) SELECT * FROM current_documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=new.name);
END;
CREATE TRIGGER analysis_update AFTER UPDATE ON analyses BEGIN
 DELETE FROM documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=new.name);
 INSERT INTO documents(name,revision,vector_id,source_json,result_json,search_text,embedding_text) SELECT * FROM current_documents WHERE name IN (SELECT name FROM sources WHERE canonical_name=new.name);
END;
