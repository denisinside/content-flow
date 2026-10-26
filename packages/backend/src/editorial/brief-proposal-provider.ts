import { z } from 'zod';
import { SourceWritingProviderError, DifyJsonWorkflowProvider } from '../evidence/writing-provider.js';
import { briefProposalWorkflowInputSchema, validateBriefProposalOutput, type BriefProposalWorkflowInput } from './brief-proposal-contracts.js';

const RELEASE = {
  releaseId: 'brief-proposal-2026-10-24.1',
  configDigest: '7e3ef0e41259725272df074366d5756fbea890e98895c20ca60ca9ce9d49544f',
  workflowIdEnv: 'DIFY_BRIEF_PROPOSAL_PUBLISHED_WORKFLOW_ID',
  configDigestEnv: 'DIFY_BRIEF_PROPOSAL_CONFIG_SHA256',
  apiKeyEnv: 'DIFY_BRIEF_PROPOSAL_API_KEY',
  apiBaseEnv: 'DIFY_API_BASE_URL',
  inputVariable: 'brief_request_json',
  outputVariable: 'brief_proposal_json',
} as const;

export const BRIEF_PROPOSAL_RELEASE_ID = RELEASE.releaseId;
export const BRIEF_PROPOSAL_CONFIG_DIGEST = RELEASE.configDigest;

export type BriefProposalWorkflowSettings = Readonly<{ endpoint: string; workflowId: string; releaseId: string; configDigest: string; apiKey: string }>;
const uuid = (value: string | undefined): value is string => !!value && z.uuid().safeParse(value).success;

function endpoint(value: string | undefined, allowLocal: boolean): string | undefined {
  try {
    const url = new URL(value ?? '');
    if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return;
    if (url.username || url.password || url.pathname.replace(/\/+$/u, '') !== '/v1' || url.search || url.hash) return;
    return `${url.origin}/v1`;
  } catch { return; }
}

export function briefProposalWorkflowRelease(env: Record<string, string | undefined> = process.env) {
  const base = endpoint(env[RELEASE.apiBaseEnv], env.NODE_ENV !== 'production');
  const workflowId = env[RELEASE.workflowIdEnv];
  if (!base || !uuid(workflowId) || env[RELEASE.configDigestEnv] !== RELEASE.configDigest) {
    throw new SourceWritingProviderError('CONFIG', 'The published brief-proposal workflow release is not configured', 'NOT_SUBMITTED');
  }
  return { endpoint: base, workflowId, releaseId: RELEASE.releaseId, configDigest: RELEASE.configDigest };
}

export function briefProposalWorkflowSettings(env: Record<string, string | undefined> = process.env): BriefProposalWorkflowSettings {
  const apiKey = env[RELEASE.apiKeyEnv];
  if (!apiKey || apiKey.length > 500) throw new SourceWritingProviderError('CONFIG', 'The brief-proposal workflow API key is missing', 'NOT_SUBMITTED');
  return { ...briefProposalWorkflowRelease(env), apiKey };
}

export const briefProposalWorkflowTransport = new DifyJsonWorkflowProvider(RELEASE.inputVariable, RELEASE.outputVariable);

export function parseBriefProposalInput(value: unknown): BriefProposalWorkflowInput {
  try { return briefProposalWorkflowInputSchema.parse(value); }
  catch { throw new SourceWritingProviderError('INVALID_INPUT', 'Frozen brief-proposal request is invalid', 'NOT_SUBMITTED'); }
}

export function validateBriefProposalProviderOutput(value: unknown, input: BriefProposalWorkflowInput) {
  try { return validateBriefProposalOutput(value, input, RELEASE.releaseId, RELEASE.configDigest); }
  catch { throw new SourceWritingProviderError('INCOMPATIBLE_CONTRACT', 'Brief-proposal workflow returned an incompatible result'); }
}
