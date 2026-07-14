/**
 * Deterministic credential/env matrix for AWS's Postman telemetry-only contract.
 *
 * AWS discovery makes no Postman asset or gateway-header calls. Postman inputs
 * exist solely to enrich anonymous telemetry (access-token selection/minting +
 * account_type). Team attribution comes only from POSTMAN_TEAM_ID — never from
 * session identity or x-entity-team-id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import {
  prepareTelemetryCredentials,
  resolveTelemetryTeamId
} from '../src/lib/postman/telemetry-credentials.js';

const TEAM_ID = '10490519';
const PMAK = 'PMAK-matrix-test';
const PROVIDED_TOKEN = 'pma_at_provided';
const MINTED_TOKEN = 'pma_at_minted';

type CredShape = 'pmak-only' | 'token-only' | 'both';
type TeamShape = 'present' | 'absent';

interface MatrixCase {
  cred: CredShape;
  team: TeamShape;
  expectMint: boolean;
  expectAccessToken: string | undefined;
  expectAccountType: string | undefined;
  expectTeamIdSource: 'POSTMAN_TEAM_ID' | 'none';
}

const MATRIX: MatrixCase[] = (
  ['pmak-only', 'token-only', 'both'] as const
).flatMap((cred) =>
  (['present', 'absent'] as const).map((team) => {
    const expectMint = cred === 'pmak-only';
    const expectAccessToken =
      cred === 'pmak-only' ? MINTED_TOKEN : PROVIDED_TOKEN;
    return {
      cred,
      team,
      expectMint,
      expectAccessToken,
      expectAccountType: 'service_account',
      expectTeamIdSource: team === 'present' ? ('POSTMAN_TEAM_ID' as const) : ('none' as const)
    };
  })
);

function credInputs(cred: CredShape): {
  postmanApiKey?: string;
  postmanAccessToken?: string;
} {
  switch (cred) {
    case 'pmak-only':
      return { postmanApiKey: PMAK };
    case 'token-only':
      return { postmanAccessToken: PROVIDED_TOKEN };
    case 'both':
      return { postmanApiKey: PMAK, postmanAccessToken: PROVIDED_TOKEN };
  }
}

function createFetchSpy(): {
  fetchImpl: typeof fetch;
  mintCount: () => number;
  sessionTokens: () => string[];
  urls: () => string[];
  headerKeys: () => string[];
} {
  let mintCount = 0;
  const sessionTokens: string[] = [];
  const urls: string[] = [];
  const headerKeys: string[] = [];

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    urls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    headerKeys.push(...Object.keys(headers).map((key) => key.toLowerCase()));

    if (url.includes('/service-account-tokens')) {
      mintCount += 1;
      expect(init?.method).toBe('POST');
      expect(headers['x-api-key']).toBe(PMAK);
      return new Response(JSON.stringify({ access_token: MINTED_TOKEN }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.includes('/api/sessions/current')) {
      const token = String(headers['x-access-token'] ?? '');
      sessionTokens.push(token);
      return new Response(
        JSON.stringify({
          session: { identity: { team: TEAM_ID }, consumerType: 'service_account' }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`unexpected fetch: ${url}`);
  });

  return {
    fetchImpl,
    mintCount: () => mintCount,
    sessionTokens: () => sessionTokens,
    urls: () => urls,
    headerKeys: () => headerKeys
  };
}

beforeEach(() => __resetIdentityMemo());
afterEach(() => vi.restoreAllMocks());

describe('AWS telemetry-only credential × POSTMAN_TEAM_ID matrix', () => {
  it.each(MATRIX)(
    '$cred × team=$team → mint=$expectMint, teamSource=$expectTeamIdSource',
    async ({
      cred,
      team,
      expectMint,
      expectAccessToken,
      expectAccountType,
      expectTeamIdSource
    }) => {
      const spy = createFetchSpy();
      const inputs = credInputs(cred);
      const env: NodeJS.ProcessEnv =
        team === 'present' ? { POSTMAN_TEAM_ID: TEAM_ID } : {};

      const prepared = await prepareTelemetryCredentials({
        ...inputs,
        fetchImpl: spy.fetchImpl
      });

      expect(spy.mintCount()).toBe(expectMint ? 1 : 0);
      expect(prepared.provider?.current()).toBe(expectAccessToken);
      expect(prepared.accountType).toBe(expectAccountType);
      expect(spy.sessionTokens()).toEqual([expectAccessToken]);

      // Telemetry-only: mint + iapub session only. No Bifrost / asset header traffic.
      expect(spy.urls().every((url) => !url.includes('/ws/proxy'))).toBe(true);
      expect(spy.headerKeys()).not.toContain('x-entity-team-id');

       const teamId = resolveTelemetryTeamId(env);
       expect(teamId ? 'POSTMAN_TEAM_ID' : 'none').toBe(expectTeamIdSource);
      expect(teamId).toBe(team === 'present' ? TEAM_ID : undefined);

      const transport = vi.fn(async () => new Response(null, { status: 204 }));
      // Explicit env overrides vitest's global POSTMAN_ACTIONS_TELEMETRY=off so
      // the enabled path is exercised when a team id is present.
      const telemetryEnv: NodeJS.ProcessEnv = {
        ...env,
        GITHUB_ACTIONS: 'true'
      };
      const telemetry = createTelemetryContext({
        action: 'postman-aws-spec-discovery-action',
        actionVersion: '0.0.0-test',
        env: telemetryEnv,
        transport: transport as unknown as typeof fetch,
        now: () => 1_700_000_000_000
      });

      telemetry.setTeamId(teamId);
      telemetry.setAccountType(prepared.accountType);
      telemetry.emitCompletion('success');

      if (team === 'absent') {
        // No team id → emit is a no-op even when telemetry is enabled.
        expect(transport).not.toHaveBeenCalled();
        return;
      }

      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const init = (transport.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(String(init?.body)) as {
        team_id: string;
        account_type: string;
        action: string;
      };
      expect(body.team_id).toBe(TEAM_ID);
      expect(body.account_type).toBe('service');
      expect(body.action).toBe('postman-aws-spec-discovery-action');
    }
  );

  it('neither credential → no mint, no account_type, team id still env-only', async () => {
    const spy = createFetchSpy();
    const prepared = await prepareTelemetryCredentials({ fetchImpl: spy.fetchImpl });
    expect(prepared).toEqual({});
    expect(spy.mintCount()).toBe(0);
    expect(spy.urls()).toEqual([]);

    const teamId = resolveTelemetryTeamId({ POSTMAN_TEAM_ID: TEAM_ID });
    expect(teamId).toBe(TEAM_ID);

    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const telemetry = createTelemetryContext({
      action: 'postman-aws-spec-discovery-action',
      env: { POSTMAN_TEAM_ID: TEAM_ID, GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch
    });
    telemetry.setTeamId(teamId);
    telemetry.setAccountType(prepared.accountType);
    telemetry.emitCompletion('success');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      String(((transport.mock.calls[0] as unknown[])[1] as RequestInit)?.body)
    );
    expect(body.account_type).toBe('unknown');
    expect(body.team_id).toBe(TEAM_ID);
  });
});
