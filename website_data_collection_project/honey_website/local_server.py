"""Run the honey website locally, without PostgreSQL or MaxMind GeoIP.

The Heroku deployment (see server.py) needs $DATABASE_URL and the GeoLite2
.mmdb files. For local development this launcher keeps server.py untouched and
instead:
  * stubs psycopg2/geoip2 so the util modules import without the real drivers,
  * logs requests to a local SQLite file (honey_local.sqlite3) using the same
    table layout as the Postgres schema in README.md.

Usage:
    python local_server.py [-p PORT]
"""

import argparse
import logging
import os
import sqlite3
import sys
import threading
import types

ROOT = os.path.dirname(os.path.abspath(__file__))
# server.py resolves static_sites/ and versions.txt relative to the cwd.
os.chdir(ROOT)
sys.path.insert(0, ROOT)

DB_FILE = os.path.join(ROOT, "honey_local.sqlite3")


# --- Stub out the drivers util/ imports at module load time -----------------

def _install_import_stubs() -> None:
    if "psycopg2" not in sys.modules:
        psycopg2 = types.ModuleType("psycopg2")
        pool = types.ModuleType("psycopg2.pool")

        class SimpleConnectionPool:  # pragma: no cover - never used locally
            def __init__(self, *args, **kwargs):
                raise RuntimeError("Postgres is not used by local_server.py")

        pool.SimpleConnectionPool = SimpleConnectionPool
        sql = types.ModuleType("psycopg2.sql")
        sql.SQL = str
        sql.Identifier = str
        psycopg2.pool = pool
        psycopg2.sql = sql
        sys.modules["psycopg2"] = psycopg2
        sys.modules["psycopg2.pool"] = pool
        sys.modules["psycopg2.sql"] = sql

    if "geoip2" not in sys.modules:
        geoip2 = types.ModuleType("geoip2")
        database = types.ModuleType("geoip2.database")

        class Reader:  # pragma: no cover - never used locally
            def __init__(self, *args, **kwargs):
                pass

            def close(self):
                pass

        database.Reader = Reader
        geoip2.database = database
        sys.modules["geoip2"] = geoip2
        sys.modules["geoip2.database"] = database


# --- SQLite-backed replacements for the Postgres loggers --------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    req_id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT, website_version TEXT, req_type TEXT,
    req_headers TEXT, req_body TEXT, req_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS improper_requests (
    req_id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT, website_version TEXT, req_type TEXT,
    req_headers TEXT, req_body TEXT, req_ts TIMESTAMP
);
CREATE TABLE IF NOT EXISTS experiment_times (
    exp_id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_version TEXT, webpage TEXT,
    start_req INTEGER, end_req INTEGER
);
CREATE TABLE IF NOT EXISTS participants (
    student_id TEXT PRIMARY KEY, name TEXT, website_version TEXT,
    forums INTEGER DEFAULT 0, flights INTEGER DEFAULT 0,
    sort INTEGER DEFAULT 0, shop INTEGER DEFAULT 0
);
"""

_db_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _init_db() -> None:
    global _conn
    _conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    _conn.executescript(SCHEMA)
    _conn.commit()


def _execute(query: str, params: tuple) -> int | None:
    with _db_lock:
        cur = _conn.execute(query, params)
        _conn.commit()
        row_id = cur.lastrowid
        cur.close()
        return row_id


class LocalRequest:
    def log_request(self, endpoint, req_type, req_headers, req_body,
                    website_version, anonymize=False):
        # No IP anonymization / GeoIP lookup locally: there is no
        # X-Forwarded-For header and no .mmdb databases.
        return _execute(
            "INSERT INTO requests (endpoint, req_type, req_headers, req_body,"
            " website_version, req_ts) VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (endpoint, req_type, req_headers, req_body, website_version),
        )


class LocalImproperRequest:
    def log_improper_request(self, endpoint, req_type, req_headers, req_body,
                             website_version):
        return _execute(
            "INSERT INTO improper_requests (endpoint, req_type, req_headers,"
            " req_body, website_version, req_ts)"
            " VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (endpoint, req_type, req_headers, req_body, website_version),
        )


class LocalExperimentTime:
    def log_start_experiment_time(self, website_version, start_req):
        return _execute(
            "INSERT INTO experiment_times (website_version, start_req)"
            " VALUES (?, ?)",
            (website_version, start_req),
        )

    def log_end_experiment_time(self, end_req, webpage, exp_id):
        _execute(
            "UPDATE experiment_times SET end_req = ?, webpage = ?"
            " WHERE exp_id = ?",
            (end_req, webpage, exp_id),
        )
        return exp_id


class LocalTaskCompletion:
    def log_task_completion(self, name, student_id, task, website_version):
        if task not in {"forums", "flights", "sort", "shop"}:
            return None
        _execute(
            "INSERT OR IGNORE INTO participants (student_id, name,"
            " website_version) VALUES (?, ?, ?)",
            (student_id, name, website_version),
        )
        _execute(
            f"UPDATE participants SET {task} = 1 WHERE student_id = ?",
            (student_id,),
        )
        return student_id

    def log_task_completion_update(self, old_student_id, name, student_id,
                                   task, website_version):
        _execute(
            "UPDATE participants SET student_id = ?, name = ?,"
            " website_version = ? WHERE student_id = ?",
            (student_id, name, website_version, old_student_id),
        )
        return self.log_task_completion(name, student_id, task,
                                        website_version)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--port", type=int,
                        default=int(os.environ.get("PORT", 34567)),
                        help="Port to run the server on (default: 34567)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    _install_import_stubs()
    _init_db()

    import server

    # server.py looks these names up in its module globals at call time.
    server.Request = LocalRequest
    server.ImproperRequest = LocalImproperRequest
    server.ExperimentTime = LocalExperimentTime
    server.TaskCompletion = LocalTaskCompletion

    with open("versions.txt") as f:
        versions = [v for v in f.read().splitlines() if v]

    httpd = server.ThreadedHTTPServer(
        ("", args.port), server.HoneySiteRequestHandler
    )
    logging.info("Logging requests to %s", DB_FILE)
    for version in versions:
        logging.info("Serving http://localhost:%d/%s/", args.port, version)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        if _conn is not None:
            _conn.close()


if __name__ == "__main__":
    main()
