"""Loopback-only Supabase-compatible routing for the disposable development stack."""
import http.server
import json
import urllib.request
import urllib.error

PUBLIC_KEY = 'taskflow-local-development-only'

class Gateway(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log tokens, request bodies, email addresses, or passwords.

    def handle_request(self):
        if self.path == '/health':
            checks = {}
            for name, url in [('auth', 'http://127.0.0.1:3999/health'), ('api', 'http://127.0.0.1:3997/ready')]:
                try:
                    with urllib.request.urlopen(url, timeout=2) as r:
                        checks[name] = r.status == 200
                except (OSError, urllib.error.HTTPError):
                    checks[name] = False
            checks['ok'] = all(checks.values())
            payload = json.dumps(checks).encode()
            self.send_response(200 if checks['ok'] else 503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(payload)
            return
        prefix = next((p for p in ['/auth/v1', '/rest/v1'] if self.path.startswith(p + '/')), None)
        if prefix is None or self.headers.get('apikey') != PUBLIC_KEY:
            self.send_error(403)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if size > 1048576:
            self.send_error(413)
            return
        body = self.rfile.read(size) if size else None
        port = 3999 if prefix == '/auth/v1' else 3998
        headers = {k:v for k,v in self.headers.items() if k.lower() in ['authorization', 'content-type', 'accept', 'content-profile', 'accept-profile', 'prefer', 'range', 'x-client-info']}
        if headers.get('Authorization') == 'Bearer ' + PUBLIC_KEY:
            del headers['Authorization']
        req = urllib.request.Request('http://127.0.0.1:' + str(port) + self.path[len(prefix):], data=body, headers=headers, method=self.command)
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            response = e
        except OSError:
            self.send_error(503)
            return
        with response:
            payload = response.read()
            self.send_response(response.status)
            for k,v in response.headers.items():
                if k.lower() in ['content-type', 'content-range', 'preference-applied', 'location']:
                    self.send_header(k,v)
            self.end_headers()
            self.wfile.write(payload)

    do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = handle_request

if __name__ == '__main__':
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    http.server.ThreadingHTTPServer(('127.0.0.1', 54321), Gateway).serve_forever()
