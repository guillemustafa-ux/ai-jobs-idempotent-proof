/**
 * HTTP client for the model provider. Its only job is to say honestly which of the
 * outcomes a remote call ended in: it worked, it failed, or nobody can tell.
 */
export type CallOutcome =
  | { kind: 'ok'; status: number; completion: string }
  /** The provider answered with an error status; it reports such requests as not billed. */
  | { kind: 'rejected'; status: number }
  /** The connection was refused: the request never left this process. */
  | { kind: 'never_sent'; error: string }
  /** Timeout or dropped connection after sending: the provider may have billed it. */
  | { kind: 'unknown'; error: string };

export interface CallRequest {
  callKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}

export async function callProvider(providerUrl: string, req: CallRequest): Promise<CallOutcome> {
  let response: Response;
  try {
    response = await fetch(`${providerUrl}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-call-key': req.callKey },
      body: JSON.stringify({ model: req.model, prompt: req.prompt }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ECONNREFUSED') return { kind: 'never_sent', error: code };
    return { kind: 'unknown', error: code };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'rejected', status: response.status };
  }

  try {
    const body = (await response.json()) as { completion: string };
    return { kind: 'ok', status: response.status, completion: body.completion };
  } catch (err) {
    // Headers arrived, the body did not: the provider did the work and may have billed it.
    return { kind: 'unknown', error: `body: ${errorCode(err)}` };
  }
}

function errorCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? e?.name ?? 'Error';
}
