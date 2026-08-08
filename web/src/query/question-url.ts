import { canonicalJson } from "./canonical";
import { compileQuestion, type QuestionState } from "./question";

const MAX_ENCODED_QUESTION = 32_768;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function encodeQuestion(question: QuestionState): string {
  compileQuestion(question);
  return base64Url(new TextEncoder().encode(canonicalJson(question)));
}

export function decodeQuestion(encoded: string): QuestionState | null {
  if (!encoded || encoded.length > MAX_ENCODED_QUESTION || !/^[\w-]+$/.test(encoded))
    return null;
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const question = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as QuestionState;
    compileQuestion(question);
    return question;
  } catch {
    return null;
  }
}
