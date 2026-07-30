"""Serve the spike page and collect its benchmark report to result.json."""

import http.server
import json
import pathlib

HERE = pathlib.Path(__file__).parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a: object, **kw: object) -> None:
        super().__init__(*a, directory=str(HERE), **kw)  # type: ignore[arg-type]

    def do_POST(self) -> None:
        if self.path == "/report":
            size = int(self.headers["Content-Length"])
            data = json.loads(self.rfile.read(size))
            (HERE / "result.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2))
            self.send_response(204)
            self.end_headers()
            print("report received", flush=True)


if __name__ == "__main__":
    http.server.HTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
