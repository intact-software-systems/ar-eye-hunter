const trustedWorkflowPath = '.github/workflows/governance-decision.yml';
const trustedWorkflowRef = `intact-software-systems/ar-eye-hunter/${trustedWorkflowPath}` + '@refs/heads/main';
export const trustedGovernanceAppSlug = 'governance-decisions';

export function verifyPublishedGovernanceDecisionCommit(verificationInput) {
    const verification = verifyHistoricalGovernanceDecisionCommit(verificationInput);
    validateCurrentAdministrator(verification.receipt.actor, verificationInput.readPermission);
    return { ...verification, authenticatedActor: verification.receipt.actor.login };
}

export function verifyHistoricalGovernanceDecisionCommit(verificationInput) {
    const verification = verificationInput.structuralVerification;
    if (verification?.decisionOnly !== true) {
        throw new Error('remote verification requires a structurally verified decision commit');
    }
    const commit = verificationInput.readCommit(verificationInput.commitOid);
    if (
        commit?.sha !== verificationInput.commitOid ||
        commit.commit?.verification?.verified !== true
    ) {
        throw new Error('governance decision commit must have GitHub verified identity');
    }
    const { actor, transport, request } = verification.receipt;
    if (transport.kind === 'local-gh') {
        validateLocalAuthor(commit.author, actor);
    }
    else {
        validateWorkflowEvidence({
            commitAuthor: commit.author,
            actor,
            transport,
            request,
            appSlug: verificationInput.appSlug,
            readWorkflowRun: verificationInput.readWorkflowRun
        });
    }
    return { ...verification, authenticatedActor: actor.login };
}

function validateCurrentAdministrator(actor, readPermission) {
    if (typeof readPermission !== 'function') {
        throw new Error('remote verification requires repository permission evidence');
    }
    const permission = readPermission(actor.login);
    if (
        permission?.permission !== 'admin' ||
        permission.user?.login !== actor.login
    ) {
        throw new Error('recorded governance actor must currently have admin permission');
    }
}

function validateLocalAuthor(author, actor) {
    if (author?.type !== 'User' || author.login !== actor.login) {
        throw new Error('local governance commit author must equal the recorded administrator');
    }
}

function validateWorkflowEvidence(evidenceInput) {
    if (evidenceInput.appSlug !== trustedGovernanceAppSlug) {
        throw new Error('configured governance App slug does not match trusted repository policy');
    }
    if (
        typeof evidenceInput.appSlug !== 'string' ||
        evidenceInput.appSlug.trim() === '' ||
        evidenceInput.commitAuthor?.type !== 'Bot' ||
        evidenceInput.commitAuthor.login !== `${evidenceInput.appSlug}[bot]` ||
        typeof evidenceInput.readWorkflowRun !== 'function'
    ) {
        throw new Error('workflow governance commit must have the configured verified App author');
    }
    const run = evidenceInput.readWorkflowRun(evidenceInput.transport.runId);
    const matches = run?.id === evidenceInput.transport.runId &&
        run.event === 'workflow_dispatch' &&
        run.run_attempt === evidenceInput.transport.runAttempt &&
        run.actor?.login === evidenceInput.actor.login &&
        run.head_sha === evidenceInput.request.expectedHeadOid &&
        run.head_sha === evidenceInput.transport.workflowSha &&
        run.path === trustedWorkflowPath &&
        run.head_branch === 'main' &&
        evidenceInput.transport.workflowRef === trustedWorkflowRef &&
        ['in_progress', 'completed'].includes(run.status);
    if (!matches) {
        throw new Error('workflow governance commit must match its exact trusted dispatch run');
    }
}
