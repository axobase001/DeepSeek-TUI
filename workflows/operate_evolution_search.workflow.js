/**
 * Operate evolution search — bounded multi-generation repair and candidate
 * refinement over sealed host-verified worktrees.
 *
 * Orchestration stays in this Workflow recipe; the host evaluator owns only
 * baseline freezing, worktree seeding from sealed parent artifacts, isolated
 * gate execution, and held-out clean replay.
 *
 * Run: /workflow run workflows/operate_evolution_search.workflow.js
 * Args: {
 *   brief, strategy: "search", evaluator: { manifestPath },
 *   writeRoots, targetFiles?, n?, generations?, rubric?,
 *   model?, thinking?, strategyProfile?
 * }
 */
export default async function (args) {
  if (args?.strategy !== "search" || !args?.evaluator?.manifestPath) {
    throw new Error(
      "Evolution search requires strategy=\"search\" and evaluator.manifestPath"
    );
  }
  const brief = String(
    args?.brief ??
      args?.task ??
      "Propose and implement the smallest correct fix for the open failure."
  );
  const exactFiles = Array.isArray(args?.targetFiles) ? args.targetFiles : [];
  const writeRoots = Array.isArray(args?.writeRoots) ? args.writeRoots : [];
  if (!exactFiles.length && !writeRoots.length) {
    throw new Error(
      "Evolution search requires bounded writeRoots or targetFiles"
    );
  }
  const population = Math.min(8, Math.max(2, Math.floor(Number(args?.n ?? 3) || 3)));
  const generations = Math.min(
    3,
    Math.max(2, Math.floor(Number(args?.generations ?? 2) || 2))
  );
  const eliteLimit = Math.min(2, population);
  const rubric = String(
    args?.rubric ??
      "Correctness on public and held-out contracts first; then minimal diff footprint, edge-case safety, and clear verification evidence."
  );
  const model = typeof args?.model === "string" ? args.model : undefined;
  const thinking =
    typeof args?.thinking === "string" ? args.thinking : undefined;

  const normalizeProfile = (raw) => ({
    profileId:
      typeof raw?.profileId === "string" && raw.profileId.trim()
        ? raw.profileId.trim().slice(0, 64)
        : "default_verified_repair",
    contractDepth: raw?.contractDepth === "strict" ? "strict" : "compact",
    planPasses: Math.min(
      2,
      Math.max(0, Math.floor(Number(raw?.planPasses ?? 1) || 0))
    ),
    repairStyle: raw?.repairStyle === "broad" ? "broad" : "surgical",
    devReview: Boolean(raw?.devReview),
  });

  const baseProfile = Object.freeze(normalizeProfile(args?.strategyProfile));
  const buildContract = (depth) => ({
    depth,
    acceptance_criteria:
      depth === "strict"
        ? [
            "Pass every isolated public gate case with exact JSON stdout contract",
            "Preserve behavior on edge cases, empty inputs, and boundary values",
            "Modify only declared write paths and leave protected tests untouched",
            "Zero unresolved blocking issues in read-only review",
          ]
        : [
            "Pass isolated public gate cases within declared write scope",
            "Pass clean-baseline replay and read-only review",
          ],
    forbidden_actions: [
      "Do not push, merge, or modify the parent checkout",
      "Do not edit tests, hidden fixtures, or evaluator configuration",
    ],
  });

  const deriveChildStep = (parentRecord, slotIndex) => {
    const prev = parentRecord.profile;
    if (parentRecord.evaluation?.status !== "PASS") {
      return {
        signal: "gate_failed",
        operator:
          slotIndex % 2 === 0 ? "targeted_gate_repair" : "planned_boundary_repair",
        profile: Object.freeze({
          ...prev,
          planPasses: Math.min(2, prev.planPasses + (slotIndex % 2 === 0 ? 0 : 1)),
          contractDepth: slotIndex % 2 === 0 ? prev.contractDepth : "strict",
          repairStyle: "surgical",
        }),
      };
    }
    if (parentRecord.devReview && parentRecord.devReview.blocking_issues.length > 0) {
      return {
        signal: "dev_review_blocked",
        operator: "contract_tightening_repair",
        profile: Object.freeze({
          ...prev,
          contractDepth: "strict",
          repairStyle: "surgical",
          devReview: true,
        }),
      };
    }
    return {
      signal: "public_pass",
      operator: slotIndex % 2 === 0 ? "edge_case_hardening" : "footprint_refinement",
      profile: Object.freeze({
        ...prev,
        contractDepth: "strict",
        repairStyle: slotIndex % 2 === 0 ? "surgical" : "broad",
      }),
    };
  };

  const buildEvidencePacket = (record) => {
    const evalReceipt = record.evaluation ?? {};
    const status = String(evalReceipt.status ?? "UNKNOWN");
    const gates = Array.isArray(evalReceipt.gates) ? evalReceipt.gates : [];
    const passedCases = gates.reduce(
      (sum, gate) => sum + Number(gate?.passed_count ?? 0),
      0
    );
    const totalCases = Number(evalReceipt.test_count ?? 0);
    const risks = [];
    if (status !== "PASS" && evalReceipt.reason) {
      risks.push(String(evalReceipt.reason));
    }
    if (record.devReview?.blocking_issues?.length) {
      risks.push(...record.devReview.blocking_issues.slice(0, 3));
    }
    const feedback = String(evalReceipt.public_failure_feedback ?? "").slice(0, 1600);
    return {
      id: `ev_${record.candidate_id}`,
      phase: record.generation === 0 ? "test" : "repair",
      candidate_id: record.candidate_id,
      status: status === "PASS" ? "passed" : status === "FAIL" ? "failed" : "unverified",
      summary: `${record.candidate_id} status=${status} cases=${passedCases}/${totalCases} files=${(evalReceipt.changed_paths ?? []).length}`,
      artifact_refs: evalReceipt.artifact_id ? [String(evalReceipt.artifact_id)] : [],
      risk_signals: risks,
      digest: [
        `STATUS: ${status} (${passedCases}/${totalCases} public cases)`,
        evalReceipt.reason ? `REASON: ${String(evalReceipt.reason)}` : "",
        feedback ? `PUBLIC GATE FEEDBACK:\n${feedback}` : "",
        record.devReview?.blocking_issues?.length
          ? `REVIEW BLOCKERS: ${JSON.stringify(record.devReview.blocking_issues)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  };

  const rankRecords = (items) =>
    [...items].sort((a, b) => {
      const score = (item) => {
        const statusOk = item.evaluation?.status === "PASS" ? 1 : 0;
        const reviewOk =
          !item.devReview || item.devReview.blocking_issues.length === 0 ? 1 : 0;
        const gates = Array.isArray(item.evaluation?.gates)
          ? item.evaluation.gates
          : [];
        const passed = gates.reduce(
          (acc, gate) => acc + Number(gate?.passed_count ?? 0),
          0
        );
        const files = item.evaluation?.changed_paths?.length ?? 999;
        return [statusOk && reviewOk ? 1 : 0, statusOk, passed, -files];
      };
      const sa = score(a);
      const sb = score(b);
      for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) return sb[i] - sa[i];
      }
      return a.candidate_id.localeCompare(b.candidate_id);
    });

  const reviewSchema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "blocking_issues", "advisory_notes"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      blocking_issues: { type: "array", items: { type: "string" } },
      advisory_notes: { type: "array", items: { type: "string" } },
    },
  };

  const frozen = await task.verifyCandidate({ action: "summary" });
  const allCandidates = [];
  const evidencePackets = [];
  const strategyMutations = [];
  let parents = [];

  for (let generation = 0; generation < generations; generation++) {
    if (generation > 0 && parents.length === 0) {
      break;
    }
    phase(`Generation ${generation}`);

    const specs = [];
    for (let index = 0; index < population; index++) {
      const candidate_id = `cand_g${generation}_${index + 1}`;
      if (generation === 0) {
        specs.push({
          candidate_id,
          generation,
          parent: null,
          stagedParent: null,
          profile: baseProfile,
          mutation: null,
        });
        continue;
      }
      const parent = parents[index % parents.length];
      const step = deriveChildStep(parent, index);
      const stagedParent = await task.verifyCandidate({
        action: "stage_parent",
        candidate_id,
        parent_candidate_id: parent.candidate_id,
      });
      const mutation = {
        generation,
        child_id: candidate_id,
        parent_id: parent.candidate_id,
        parent_artifact_id: stagedParent.parent_artifact_id,
        signal: step.signal,
        operator: step.operator,
        profile: step.profile,
      };
      strategyMutations.push(mutation);
      specs.push({
        candidate_id,
        generation,
        parent,
        stagedParent,
        profile: step.profile,
        mutation,
      });
    }

    const workerOutputs = await parallel(
      specs.map((spec) => async () => {
        const contract = buildContract(spec.profile.contractDepth);
        const notes = [];
        for (let pass = 1; pass <= spec.profile.planPasses; pass++) {
          try {
            const planned = await task({
              description: [
                "Produce one concise implementation plan for this isolated coding task.",
                "Do not call tools or edit files. Return JSON matching the schema.",
                `BRIEF:\n${brief}`,
                `CONTRACT:\n${JSON.stringify(contract)}`,
                spec.parent ? `PARENT EVIDENCE:\n${spec.parent.packet.digest}` : "",
                `PLAN PASS: ${pass} of ${spec.profile.planPasses}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              label: `plan_${spec.candidate_id}_${pass}`,
              type: "explore",
              ...(model ? { model } : {}),
              allowedTools: [],
              schemaRepairAttempts: 0,
              writeAuthority: "read_only",
              worktree: false,
              responseSchema: {
                type: "object",
                additionalProperties: false,
                required: ["plan"],
                properties: { plan: { type: "string" } },
              },
            });
            notes.push(String(planned?.plan ?? "").slice(0, 2000));
          } catch (error) {
            notes.push(`Plan pass ${pass} skipped: ${String(error).slice(0, 240)}`);
          }
        }

        return task({
          description: [
            "You are an isolated candidate in a host-verified Codewhale search.",
            "Edit only within the declared write scope inside this worktree.",
            "Do not push, merge, touch protected tests, or rely on self-reported test claims.",
            `BRIEF:\n${brief}`,
            `RUBRIC:\n${rubric}`,
            `CONTRACT:\n${JSON.stringify(contract)}`,
            notes.length ? `PLANNING NOTES:\n${notes.join("\n---\n")}` : "",
            spec.parent
              ? [
                  `SEEDED PARENT: ${spec.parent.candidate_id} (artifact ${spec.stagedParent.parent_artifact_id})`,
                  "Your worktree already starts from the parent's sealed source files. Read target files before editing.",
                  spec.profile.repairStyle === "surgical"
                    ? "Apply the smallest targeted change that resolves the verified failure or blocker without breaking passing behavior."
                    : "Refactor the target module cleanly to satisfy all contract boundaries while preserving public interfaces.",
                  `PARENT EVIDENCE:\n${spec.parent.packet.digest}`,
                ].join("\n")
              : "Implement a clean first-generation solution and declare modified paths under CHANGES.",
            `CANDIDATE ID: ${spec.candidate_id}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          label: spec.candidate_id,
          type: "implementer",
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          worktree: true,
          writeAuthority: "worktree_write",
          ...(exactFiles.length ? { exactFiles } : {}),
          ...(writeRoots.length ? { writeRoots } : {}),
          coordinationContracts: [`evolution-${spec.candidate_id}`],
        });
      }),
      { mode: "partial" }
    );

    const generationRecords = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const workerOutput = workerOutputs[index];
      let evaluation;
      if (workerOutput === null || workerOutput?.__taskError) {
        evaluation = {
          status: "UNKNOWN",
          reason: String(workerOutput?.message ?? "candidate worker did not complete"),
        };
      } else {
        try {
          evaluation = await task.verifyCandidate({
            action: "evaluate",
            candidate_id: spec.candidate_id,
          });
        } catch (error) {
          evaluation = { status: "UNKNOWN", reason: String(error) };
        }
      }

      let devReview = null;
      if (
        spec.profile.devReview &&
        evaluation?.status === "PASS" &&
        evaluation?.review_complete === true &&
        typeof evaluation?.review_material === "string"
      ) {
        try {
          devReview = await task({
            description: [
              "Review this public-gate-verified candidate diff in read-only mode.",
              "List only concrete defects or contract violations in blocking_issues; put minor style suggestions in advisory_notes.",
              "Do not call tools.",
              `BRIEF:\n${brief}`,
              `ARTIFACT ID: ${String(evaluation.artifact_id)}`,
              `CHANGED FILES:\n${evaluation.review_material}`,
            ].join("\n\n"),
            label: `dev_review_${spec.candidate_id}`,
            type: "review",
            ...(model ? { model } : {}),
            allowedTools: [],
            schemaRepairAttempts: 1,
            writeAuthority: "read_only",
            worktree: false,
            responseSchema: reviewSchema,
          });
        } catch (error) {
          devReview = {
            verdict: "fail",
            blocking_issues: [`DEV review incomplete: ${String(error).slice(0, 240)}`],
            advisory_notes: [],
          };
        }
      }

      const record = {
        candidate_id: spec.candidate_id,
        generation,
        parent_candidate_id: spec.parent?.candidate_id ?? null,
        parent_artifact_id: spec.stagedParent?.parent_artifact_id ?? null,
        profile: spec.profile,
        mutation: spec.mutation,
        evaluation,
        devReview,
        packet: null,
      };
      record.packet = buildEvidencePacket(record);
      evidencePackets.push(record.packet);
      generationRecords.push(record);
      allCandidates.push(record);
    }

    const seedEligible = generationRecords.filter(
      (item) =>
        (item.evaluation?.status === "PASS" || item.evaluation?.status === "FAIL") &&
        typeof item.evaluation?.artifact_id === "string"
    );
    parents = rankRecords(seedEligible).slice(0, eliteLimit);
  }

  const verifiedPublic = rankRecords(
    allCandidates.filter((item) => item.evaluation?.status === "PASS")
  );
  let winner_id = "NONE";
  let replay = null;
  let review = null;

  if (verifiedPublic.length > 0) {
    const provisional = verifiedPublic[0];
    phase("Clean-baseline replay");
    try {
      replay = await task.verifyCandidate({
        action: "replay",
        candidate_id: provisional.candidate_id,
      });
    } catch (error) {
      replay = { status: "UNKNOWN", reason: String(error) };
    }

    if (
      replay?.status === "PASS" &&
      replay?.artifact_id === provisional.evaluation?.artifact_id &&
      provisional.evaluation?.review_complete === true &&
      typeof provisional.evaluation?.review_material === "string"
    ) {
      phase("Read-only final review");
      try {
        const verdict = await task({
          description: [
            "Perform final read-only review of this candidate after clean public + held-out replay.",
            "Report true correctness, security, or contract regressions in blocking_issues.",
            "Keep non-fatal polish items in advisory_notes so valid fixes are not discarded.",
            "Do not call tools.",
            `BRIEF:\n${brief}`,
            `RUBRIC:\n${rubric}`,
            `ARTIFACT ID: ${String(provisional.evaluation.artifact_id)}`,
            `REPLAY SUMMARY: status=${String(replay.status)} test_count=${String(replay.test_count)}`,
            `COMPLETE CHANGED FILES:\n${provisional.evaluation.review_material}`,
          ].join("\n\n"),
          label: "final_reviewer",
          type: "review",
          ...(model ? { model } : {}),
          allowedTools: [],
          schemaRepairAttempts: 1,
          writeAuthority: "read_only",
          worktree: false,
          responseSchema: reviewSchema,
        });
        review = {
          ...verdict,
          candidate_id: provisional.candidate_id,
          artifact_id: provisional.evaluation.artifact_id,
          review_material_sha256: provisional.evaluation.review_material_sha256,
        };
        if (
          review.verdict === "pass" &&
          Array.isArray(review.blocking_issues) &&
          review.blocking_issues.length === 0
        ) {
          winner_id = provisional.candidate_id;
        }
      } catch (error) {
        review = {
          verdict: "fail",
          candidate_id: provisional.candidate_id,
          artifact_id: provisional.evaluation.artifact_id,
          blocking_issues: [`Final review failed: ${String(error).slice(0, 300)}`],
          advisory_notes: [],
        };
      }
    }
  }

  return {
    scenario: "operate-verified-evolution",
    strategy: "search",
    brief,
    rubric,
    population,
    generations,
    frozen,
    winner_id,
    replay,
    review,
    candidates: allCandidates.map((item) => ({
      candidate_id: item.candidate_id,
      generation: item.generation,
      parent_candidate_id: item.parent_candidate_id,
      parent_artifact_id: item.parent_artifact_id,
      profile: item.profile,
      evaluation: item.evaluation,
      dev_review: item.devReview,
    })),
    run_trace: {
      objective: brief,
      initial_profile: baseProfile,
      contract: buildContract(baseProfile.contractDepth),
      lineage_edges: allCandidates
        .filter((item) => item.parent_candidate_id)
        .map((item) => ({
          parent: item.parent_candidate_id,
          child: item.candidate_id,
          parent_artifact_id: item.parent_artifact_id,
        })),
      strategy_mutations: strategyMutations,
      evidence_packets: evidencePackets,
    },
    promotion: "proposal_only",
    apply_policy:
      "Explicit human review is required before any apply, push, or merge.",
  };
}
