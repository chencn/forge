import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHttpCookies,
  executeHttpRequest,
  formatHttpExchange,
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
    expect(file.requests[1]).toMatchObject({
      line: 5,
      method: "GET",
      title: "List",
      url: "https://example.com/topics/1",
    });
    expect(file.requests[2].body).toBe('{"name":"sample"}\n# kept in the body');
    expect(file.requests[2].headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
    expect(httpRequestLabel(file.requests[1])).toBe("List");
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
    expect(body).toContain(`"at": "${now.getTime()}"`);
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
