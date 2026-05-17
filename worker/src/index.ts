/**
 * Clicky Proxy Worker
 *
 * Proxies production Clicky requests to the original Worker, while allowing
 * /tts to use Fish Audio. Keys are stored as Cloudflare secrets.
 *
 * Routes:
 *   *          → Original Clicky Worker
 *   POST /tts  → Fish Audio TTS by default
 */

interface Env {
  FISH_AUDIO_API_KEY?: string;
  FISH_AUDIO_PRIMARY_REFERENCE_ID?: string;
  FISH_AUDIO_SECONDARY_REFERENCE_ID?: string;
}

type TTSVoiceKey = "elevenlabs-default" | "fish-primary" | "fish-secondary";

interface TTSRequestBody {
  text?: string;
  voice_key?: TTSVoiceKey;
  voice_id?: string;
  voiceId?: string;
  model_id?: string;
  voice_settings?: unknown;
}

const ORIGINAL_CLICKY_WORKER_BASE_URL = "https://clicker-proxy-v2.farza-0cb.workers.dev";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/tts") {
        return await handleTTS(request, env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return await forwardToOriginalClickyWorker(request);
  },
};

async function forwardToOriginalClickyWorker(request: Request): Promise<Response> {
  const originalURL = new URL(request.url);
  originalURL.protocol = "https:";
  originalURL.host = new URL(ORIGINAL_CLICKY_WORKER_BASE_URL).host;

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("host", originalURL.host);

  return await fetch(originalURL.toString(), {
    method: request.method,
    headers: forwardedHeaders,
    body: request.body,
    redirect: "manual",
  });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const requestBody = await parseTTSRequestBody(request);
  const voiceKey = resolveTTSVoiceKey(requestBody);

  if (voiceKey === "elevenlabs-default") {
    return await forwardToOriginalClickyWorker(request);
  }

  return await handleFishAudioTTS(requestBody, env, voiceKey);
}

async function parseTTSRequestBody(request: Request): Promise<TTSRequestBody> {
  const requestBody = await request.json<TTSRequestBody>();

  if (!requestBody.text || typeof requestBody.text !== "string") {
    throw new Error("TTS request requires a text field");
  }

  return requestBody;
}

function resolveTTSVoiceKey(requestBody: TTSRequestBody): "elevenlabs-default" | "fish-primary" | "fish-secondary" {
  if (requestBody.voice_key === "elevenlabs-default") {
    return "elevenlabs-default";
  }

  if (requestBody.voice_key === "fish-secondary") {
    return "fish-secondary";
  }

  const requestedVoiceID = requestBody.voice_id || requestBody.voiceId;
  if (requestedVoiceID === "fish-secondary") {
    return "fish-secondary";
  }

  if (requestBody.text && spokenTextLooksLikeRapOrLyrics(requestBody.text)) {
    return "fish-secondary";
  }

  return "fish-primary";
}

function spokenTextLooksLikeRapOrLyrics(spokenText: string): boolean {
  const lowercasedText = spokenText.toLowerCase();
  const rapCueWords = ["rap", "verse", "chorus", "hook", "bars", "flow", "rhyme"];

  if (rapCueWords.some((cueWord) => lowercasedText.includes(cueWord))) {
    return true;
  }

  const nonEmptyLines = spokenText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return nonEmptyLines.length >= 4;
}

async function handleFishAudioTTS(
  requestBody: TTSRequestBody,
  env: Env,
  voiceKey: "fish-primary" | "fish-secondary"
): Promise<Response> {
  if (!env.FISH_AUDIO_API_KEY) {
    return new Response(JSON.stringify({ error: "Fish Audio API key is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const referenceId =
    voiceKey === "fish-primary"
      ? env.FISH_AUDIO_PRIMARY_REFERENCE_ID
      : env.FISH_AUDIO_SECONDARY_REFERENCE_ID;

  if (!referenceId) {
    return new Response(JSON.stringify({ error: `${voiceKey} is not configured` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const fishAudioRequestBody = {
    text: requestBody.text,
    reference_id: referenceId,
    format: "mp3",
    mp3_bitrate: 128,
    latency: "balanced",
    normalize: true,
  };

  const response = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`,
      "content-type": "application/json",
      accept: "audio/mpeg",
      model: "s2-pro",
    },
    body: JSON.stringify(fishAudioRequestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[/tts] Fish Audio API error ${response.status}: ${errorBody}`);
    return new Response(errorBody, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
  });
}
