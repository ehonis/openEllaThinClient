import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { z } from "zod";

const Env = z.object({
  BRAIN_URL: z.string().default("http://192.168.1.152:8787/chat"),
  DEBUG: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

const env = Env.parse({
  BRAIN_URL: process.env.BRAIN_URL,
  DEBUG: process.env.DEBUG,
});

type OllamaNdjson = {
  model?: string;
  created_at?: string;
  response?: string;
  done?: boolean;
  done_reason?: string;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function streamChat(prompt: string) {
  const start = nowMs();

  const res = await fetch(env.BRAIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Your server.ts currently expects { prompt }, and always streams.
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buf = "";
  let firstTokenAt: number | null = null;
  let tokenChars = 0;
  let lastMsg: OllamaNdjson | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    while (true) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;

      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);

      if (!line) continue;

      if (env.DEBUG) {
        console.error(`[ndjson] ${line}`);
      }

      let msg: OllamaNdjson;
      try {
        msg = JSON.parse(line) as OllamaNdjson;
      } catch (e) {
        console.error(`Failed to parse NDJSON line: ${line}`);
        continue;
      }

      lastMsg = msg;

      if (msg.response) {
        if (firstTokenAt == null) firstTokenAt = nowMs();
        tokenChars += msg.response.length;
        process.stdout.write(msg.response);
      }

      if (msg.done) {
        process.stdout.write("\n");
      }
    }
  }

  const end = nowMs();
  const ttfb = firstTokenAt == null ? null : firstTokenAt - start;

  console.error(
    JSON.stringify(
      {
        promptChars: prompt.length,
        msTotal: end - start,
        msToFirstToken: ttfb,
        tokenChars,
        ollama: lastMsg
          ? {
              done_reason: lastMsg.done_reason,
              total_duration: lastMsg.total_duration,
              load_duration: lastMsg.load_duration,
              prompt_eval_count: lastMsg.prompt_eval_count,
              eval_count: lastMsg.eval_count,
            }
          : null,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const argPrompt = process.argv.slice(2).join(" ").trim();

  if (argPrompt) {
    await streamChat(argPrompt);
    return;
  }

  const rl = createInterface({ input, output });

  while (true) {
    const text = (await rl.question("> ")).trim();
    if (!text) continue;
    if (text === "/q" || text === "/quit" || text === "q") break;
    await streamChat(text);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});