import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHttpCookies,
  createHttpRunSession,
  executeHttpRequest,
  formatHttpExchange,
  httpRequestAtLine,
  httpRequestLabel,
  isHttpFile,
  parseHttpFile,
  type HttpCall,
  type HttpResult,
} from "../../src/lib/httpFile";

function result(partial: Partial<HttpResult> = {}): HttpResult {
  const body = partial.body ?? "";
  return {
    status: 200,
    reason: "OK",
    headers: [],
    body,
    binary: false,
    truncated: false,
    bodyBytes: new TextEncoder().encode(body).length,
    elapsedMs: 5,
    finalUrl: "https://example.com/",
    ...partial,
  };
}

async function sendOf(fileText: string, line: number, options: Parameters<typeof executeHttpRequest>[2] = {}) {
  const file = parseHttpFile(fileText);
  const request = file.requests.find((item) => item.line === line);
  if (!request) throw new Error(`no request on line ${line}`);
  const calls: HttpCall[] = [];
  const sent = await executeHttpRequest(file, request, {
    dir: "/tmp/api",
    ...options,
    send: async (call) => {
      calls.push(call);
      if (options.send) return options.send(call);
      return result({ finalUrl: call.url, body: "" });
    },
  });
  return { calls, sent, request };
}

describe("parseHttpFile", () => {
  it("ignores preamble text and method names without a target", () => {
    expect(parseHttpFile("hello world\n").requests).toEqual([]);
    expect(parseHttpFile("GET\n").requests).toEqual([]);
    const file = parseHttpFile("# @name health\nnotes for this request\nGET http://localhost:9000\n");
    expect(file.requests).toHaveLength(1);
    expect(file.requests[0]).toMatchObject({ name: "health", method: "GET", url: "http://localhost:9000" });
  });

  it("skips a response handler directly after the headers", () => {
    const file = parseHttpFile('GET http://localhost:9000\n> {%\nclient.log("hidden");\n%}\n');
    expect(file.requests[0]!.body).toBe("");
  });

  it("accepts name= metadata and URL path continuations", () => {
    const file = parseHttpFile("# @name=health\nGET http://localhost:9000\n  /status\n  ?full=true\n");
    expect(file.requests[0]).toMatchObject({ name: "health", url: "http://localhost:9000/status?full=true", body: "" });
  });

  it("excludes response directives and indented handlers from the sent body", () => {
    const file = parseHttpFile('POST http://localhost:9000\n\n{"ok":true}\n  > {%\nclient.log("hidden");\n  %}\n<> old.json\n  >> saved.json\n');
    expect(JSON.parse(file.requests[0]!.body)).toEqual({ ok: true });
  });

  it("parses requests, comments, default GET and the HTTP version", () => {
    const file = parseHttpFile(`# comment
GET https://example.com/comments/1 HTTP/1.1

### List
https://example.com/topics/1

###
POST https://example.com/comments
Content-Type: application/json

{"name":"sample"}
# kept in the body
> {%
client.test()
%}
`);
    expect(file.requests).toHaveLength(3);
    expect(file.requests[0]).toMatchObject({
      line: 2,
      method: "GET",
      url: "https://example.com/comments/1",
      body: "",
    });
    expect(file.requests[0]).toMatchObject({ startLine: 1, endLine: 2 });
    expect(file.requests[1]).toMatchObject({
      line: 5,
      startLine: 5,
      method: "GET",
      title: "List",
      url: "https://example.com/topics/1",
    });
    expect(file.requests[2].body).toBe('{"name":"sample"}\n# kept in the body');
    expect(file.requests[2].headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
    expect(httpRequestLabel(file.requests[1])).toBe("List");
  });

  it("treats a caret inside the request block as that request", () => {
    const file = parseHttpFile(`# comment
GET https://example.com/a

### Next
POST https://example.com/b
Content-Type: text/plain

hello
`);
    expect(file.requests[0]).toMatchObject({ line: 2, startLine: 1, endLine: 2 });
    expect(file.requests[1]).toMatchObject({ line: 5, startLine: 5, endLine: 8 });
    expect(httpRequestAtLine(file, 1)?.line).toBe(2);
    expect(httpRequestAtLine(file, 6)?.method).toBe("POST");
    expect(httpRequestAtLine(file, 8)?.method).toBe("POST");
  });

  it("joins query lines and folded header values", () => {
    const file = parseHttpFile(`GET https://example.com/comments?page=1
    ?page=2
    &pageSize=10
Accept: text/plain,
    text/html
`);
    expect(file.requests[0].url).toBe("https://example.com/comments?page=1&page=2&pageSize=10");
    expect(file.requests[0].headers[0].value).toBe("text/plain, text/html");
  });

  it("names a request and keeps file variables", () => {
    const file = parseHttpFile(`@host = example.com
@note = line\\nbreak

# @name login
POST https://{{host}}/login
`);
    expect(file.variables.map((item) => [item.name, item.value])).toEqual([
      ["host", "example.com"],
      ["note", "line\nbreak"],
    ]);
    expect(file.requests[0].name).toBe("login");
    expect(isHttpFile("api.rest")).toBe(true);
    expect(isHttpFile("api.HTTP")).toBe(true);
    expect(isHttpFile("api.http.txt")).toBe(false);
  });
});

describe("executeHttpRequest", () => {
  beforeEach(() => {
    clearHttpCookies();
  });

  it("resolves relative URLs against the substituted Host header", async () => {
    const { calls } = await sendOf("GET /status\nhOsT: {{host}}\n", 1, { envVars: { host: "localhost:9000" } });
    expect(calls[0]!.url).toBe("http://localhost:9000/status");
    await expect(sendOf("GET /status\n", 1)).rejects.toContain("HTTP_URL");
  });

  it.each([
    "GET https://{{host}}/status\n",
    "POST http://localhost:9000\nAuthorization: Bearer {{token}}\n\n{}\n",
    'POST http://localhost:9000\n\n{"id":"{{id}}"}\n',
  ])("rejects unresolved variables before sending: %s", async (text) => {
    const send = vi.fn(async () => result());
    const file = parseHttpFile(text);
    await expect(executeHttpRequest(file, file.requests[0]!, { send })).rejects.toContain("HTTP_VARIABLE");
    expect(send).not.toHaveBeenCalled();
  });

  it("supports the original dynamic variables and seconds timestamp", async () => {
    const now = new Date("2020-01-02T03:04:05.678Z");
    const { calls } = await sendOf('POST http://localhost:9000\n\n{"uuid":"{{$random.uuid}}","iso":"{{$isoTimestamp}}","n":{{$random.integer()}},"other":{{$random.integer}},"default":{{$randomInt}},"time":{{$timestamp}}}\n', 1, { now });
    const body = JSON.parse(calls[0]!.body[0]!.text!);
    expect(body.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.iso).toBe("2020-01-02T03:04:05Z");
    for (const value of [body.n, body.other, body.default]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1000);
    }
    expect(body.time).toBe(Math.floor(now.getTime() / 1000));
  });

  it("recognizes indented file includes", async () => {
    const { calls } = await sendOf("POST http://localhost:9000\n\n  < ./payload.json\n", 1);
    expect(calls[0]!.body).toEqual([{ file: "/tmp/api/payload.json" }]);
  });

  it("substitutes file variables, system variables and prompts", async () => {
    const now = new Date("2020-01-02T03:04:05.678Z");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { calls } = await sendOf(
      `@host = example.com
@base = https://{{host}}/api
@name = ada

# @prompt username Your name
POST {{base}}/users HTTP/1.1
Content-Type: application/json

{
  "id": "{{$guid}}",
  "at": "{{$timestamp}}",
  "day": "{{$datetime "YYYY-MM-DD"}}",
  "n": "{{$randomInt 5 8}}",
  "who": "{{username}}",
  "note": "{{name}}"
}
`,
      6,
      {
        now,
        prompt: (name) => (name === "username" ? "ada-prompt" : null),
      }
    );
    vi.restoreAllMocks();
    const call = calls[0];
    expect(call.url).toBe("https://example.com/api/users");
    const body = call.body[0]?.text ?? "";
    expect(body).toContain(`"at": "${Math.floor(now.getTime() / 1000)}"`);
    expect(body).toContain('"day": "2020-01-02"');
    expect(body).toContain('"n": "5"');
    expect(body).toContain('"who": "ada-prompt"');
    expect(body).toContain('"note": "ada"');
    expect(body).toMatch(/"id": "[0-9a-f-]{36}"/);
  });

  it("runs a named request before using its response", async () => {
    const { calls } = await sendOf(
      `# @name login
POST https://example.com/login

###

@token = {{login.response.body.$.token}}

GET https://example.com/users/{{login.response.body.$.id}}
Authorization: {{token}}
X-From: {{login.response.headers.X-Auth}}
`,
      8,
      {
        send: async (call) => {
          if (call.url.endsWith("/login")) {
            return result({
              finalUrl: call.url,
              body: '{"id":7,"token":"abc"}',
              headers: [{ name: "X-Auth", value: "yes" }],
            });
          }
          return result({ finalUrl: call.url, body: "ok" });
        },
      }
    );
    expect(calls.map((call) => call.url)).toEqual([
      "https://example.com/login",
      "https://example.com/users/7",
    ]);
    expect(calls[1].headers).toEqual([
      { name: "Authorization", value: "abc" },
      { name: "X-From", value: "yes" },
    ]);
  });

  it("forwards resolved response data containing literal template braces", async () => {
    const { calls } = await sendOf("# @name first\nGET http://localhost:9000/first\n\n###\n@payload = {{first.response.body.*}}\nPOST http://localhost:9000/next\n\n{{payload}}\n", 6, {
      send: async (call) => result({ finalUrl: call.url, body: "{{literal}}" }),
    });
    expect(calls[1]!.body).toEqual([{ text: "{{literal}}" }]);
  });

  it("reports unresolved names nested in file and environment variables", async () => {
    const send = vi.fn(async () => result());
    const file = parseHttpFile("@auth = {{token}}\nGET http://localhost:9000\nAuthorization: {{auth}}\n");
    await expect(executeHttpRequest(file, file.requests[0]!, { send, envVars: { token: "{{missing}}" } })).rejects.toBe("HTTP_VARIABLE\u0001missing");
    expect(send).not.toHaveBeenCalled();
  });

  it("reuses a named response from the same run instead of sending it again", async () => {
    const session = createHttpRunSession();
    const text = `# @name login
POST https://example.com/login

###
GET https://example.com/users/{{login.response.body.$.id}}
`;
    const file = parseHttpFile(text);
    const send = vi.fn(async (call: HttpCall) => {
      if (call.url.endsWith("/login")) {
        return result({ finalUrl: call.url, body: '{"id":7}' });
      }
      return result({ finalUrl: call.url, body: "ok" });
    });
    await executeHttpRequest(file, file.requests[0]!, { dir: "/tmp/api", send, session });
    await executeHttpRequest(file, file.requests[1]!, { dir: "/tmp/api", send, session });
    expect(send.mock.calls.map(([call]) => call.url)).toEqual([
      "https://example.com/login",
      "https://example.com/users/7",
    ]);
  });

  it("reads a JSON path, an XML attribute and keeps cookies", async () => {
    const { calls } = await sendOf(
      `# @name list
GET https://example.com/replies

###
GET https://example.com/replies/{{list.response.body.//reply[2]/@id}}
`,
      5,
      {
        send: async (call) => {
          if (call.url.endsWith("/replies")) {
            return result({
              finalUrl: call.url,
              body: '<replies><reply id="9"/><reply id="10"/></replies>',
              headers: [{ name: "Set-Cookie", value: "sid=1; Path=/" }],
            });
          }
          return result({ finalUrl: call.url, body: "ok" });
        },
      }
    );
    expect(calls[1].url).toBe("https://example.com/replies/10");
    expect(calls[1].headers).toContainEqual({ name: "Cookie", value: "sid=1" });
  });

  it("stops when two named requests depend on each other", async () => {
    const file = parseHttpFile(`# @name a
GET https://example.com/{{b.response.body.*}}

###
# @name b
GET https://example.com/{{a.response.body.*}}
`);
    await expect(executeHttpRequest(file, file.requests[0], { dir: "/tmp/api" })).rejects.toContain(
      "HTTP_CYCLE"
    );
  });

  it("loads dotenv, process env and an included file", async () => {
    const { calls } = await sendOf(
      `@name = world
POST https://example.com
Authorization: {{$dotenv TOKEN}}
X-User: {{$processEnv USER}}

<@ ./demo.xml
`,
      2,
      {
        readText: async (path) => {
          if (path.endsWith(".env")) return "TOKEN=secret\n";
          expect(path).toBe("/tmp/api/demo.xml");
          return "hello {{name}}";
        },
        processEnv: async (name) => (name === "USER" ? "ada" : null),
      }
    );
    expect(calls[0].headers).toEqual([
      { name: "Authorization", value: "secret" },
      { name: "X-User", value: "ada" },
    ]);
    expect(calls[0].body).toEqual([{ text: "hello world" }]);
  });

  it("falls back to the workspace when the include is not next to the file", async () => {
    const { calls } = await sendOf(
      `POST https://example.com

< ./payload.json
`,
      1,
      {
        workspace: "/tmp",
        exists: async (path) => path === "/tmp/payload.json",
      }
    );
    expect(calls[0].body).toEqual([{ file: "/tmp/payload.json" }]);
  });

  it("sends a raw file path without reading it as text", async () => {
    const readText = vi.fn(async () => "nope");
    const { calls } = await sendOf(
      `POST https://example.com

< ./demo.bin
`,
      1,
      { readText }
    );
    expect(readText).not.toHaveBeenCalled();
    expect(calls[0].body).toEqual([{ file: "/tmp/api/demo.bin" }]);
  });

  it("stops before the next send once the run is cancelled", async () => {
    let sent = 0;
    const send = vi.fn(async () => {
      sent += 1;
      return result({ body: "token" });
    });
    const file = parseHttpFile(
      "# @name login\nGET https://example.com/login\n\n###\nGET https://example.com/me\nAuthorization: Bearer {{login.response.body}}\n"
    );
    await expect(
      executeHttpRequest(file, file.requests[1]!, {
        dir: "/tmp/api",
        send,
        isCancelled: () => sent > 0,
      })
    ).rejects.toContain("HTTP_CANCELLED");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-http URL and a non-utf8 include", async () => {
    const file = parseHttpFile("GET file:///tmp/a\n");
    await expect(executeHttpRequest(file, file.requests[0])).rejects.toContain("HTTP_URL");
    const encoded = parseHttpFile("POST https://example.com\n\n<@latin1 ./a\n");
    await expect(executeHttpRequest(encoded, encoded.requests[0], { dir: "/tmp/api" })).rejects.toContain(
      "HTTP_ENCODING"
    );
  });

  it("adds http when the request line omits the scheme", async () => {
    const { calls } = await sendOf("GET localhost:8080/health\n", 1);
    expect(calls[0].url).toBe("http://localhost:8080/health");
  });

  it("parses curl and wraps a GraphQL body", async () => {
    const curl = await sendOf(
      String.raw`curl -X POST https://example.com/comments -H "Content-Type: application/json" -u ada:secret -d "{\"a\":1}"` +
        "\n",
      1
    );
    expect(curl.calls[0].method).toBe("POST");
    expect(curl.calls[0].url).toBe("https://example.com/comments");
    expect(curl.calls[0].headers).toContainEqual({ name: "Content-Type", value: "application/json" });
    expect(curl.calls[0].headers).toContainEqual({
      name: "Authorization",
      value: `Basic ${btoa("ada:secret")}`,
    });
    expect(curl.calls[0].body).toEqual([{ text: '{"a":1}' }]);

    const graphql = await sendOf(
      `POST https://api.github.com/graphql
X-Request-Type: GraphQL

query { a }

{"id":1}
`,
      1
    );
    expect(JSON.parse(graphql.calls[0].body[0]?.text ?? "")).toEqual({
      query: "query { a }",
      variables: { id: 1 },
    });
  });

  it("joins form fields that start with &", async () => {
    const { calls } = await sendOf(
      `POST https://api.example.com/login
Content-Type: application/x-www-form-urlencoded

name=foo
&password=bar
`,
      1
    );
    expect(calls[0].body).toEqual([{ text: "name=foo&password=bar" }]);
  });
});

describe("formatHttpExchange", () => {
  it("pretty-prints JSON and marks a binary body", () => {
    const text = formatHttpExchange(
      result({
        status: 201,
        reason: "Created",
        finalUrl: "https://example.com/a",
        elapsedMs: 12,
        headers: [{ name: "content-type", value: "application/json" }],
        body: '{"a":1}',
        bodyBytes: 7,
      }),
      { binary: "BIN", truncated: "TRUNC" }
    );
    expect(text).toContain("HTTP/1.1 201 Created");
    expect(text).toContain('{\n  "a": 1\n}');

    const binary = formatHttpExchange(
      result({ binary: true, body: "", headers: [{ name: "content-type", value: "image/png" }] }),
      { binary: "BIN", truncated: "TRUNC" }
    );
    expect(binary).toContain("BIN");
  });
});
