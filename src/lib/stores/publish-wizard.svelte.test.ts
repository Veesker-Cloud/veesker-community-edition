import { describe, it, expect } from "vitest";
import { createPublishWizard } from "./publish-wizard.svelte";

describe("publish-wizard — lastBuildOutPath", () => {
  it("starts as null on a fresh wizard", () => {
    const w = createPublishWizard();
    expect(w.state.publish.lastBuildOutPath).toBeNull();
  });

  it("setLastBuildOutPath stores and clears the path", () => {
    const w = createPublishWizard();
    w.setLastBuildOutPath("C:/tmp/sb-1234.vsk");
    expect(w.state.publish.lastBuildOutPath).toBe("C:/tmp/sb-1234.vsk");
    w.setLastBuildOutPath(null);
    expect(w.state.publish.lastBuildOutPath).toBeNull();
  });

  it("reset() clears lastBuildOutPath alongside the rest of publish state", () => {
    const w = createPublishWizard();
    w.setLastBuildOutPath("C:/tmp/sb-9999.vsk");
    w.setSandboxId("sb-9999");
    w.setPublishPhase("error", "boom");
    w.reset();
    expect(w.state.publish.lastBuildOutPath).toBeNull();
    expect(w.state.publish.sandboxId).toBeNull();
    expect(w.state.publish.phase).toBe("idle");
    expect(w.state.publish.error).toBeNull();
  });

  it("survives a setPublishPhase('error') — the wizard does not auto-clear it", () => {
    // The wizard layer just stores the path; clearing on terminal states is
    // the orchestrator's responsibility. This contract is important: a
    // failed Upload must leave lastBuildOutPath populated so the user can
    // hit "Retry upload only".
    const w = createPublishWizard();
    w.setLastBuildOutPath("C:/tmp/sb-abc.vsk");
    w.setPublishPhase("error", "upload network failed");
    expect(w.state.publish.lastBuildOutPath).toBe("C:/tmp/sb-abc.vsk");
  });
});

describe("publish-wizard — uploadProgress", () => {
  it("starts as null", () => {
    const w = createPublishWizard();
    expect(w.state.publish.uploadProgress).toBeNull();
  });

  it("setUploadProgress stores and clears", () => {
    const w = createPublishWizard();
    w.setUploadProgress({ bytesUploaded: 1024, totalBytes: 10240 });
    expect(w.state.publish.uploadProgress).toEqual({
      bytesUploaded: 1024,
      totalBytes: 10240,
    });
    w.setUploadProgress(null);
    expect(w.state.publish.uploadProgress).toBeNull();
  });

  it("reset() clears uploadProgress", () => {
    const w = createPublishWizard();
    w.setUploadProgress({ bytesUploaded: 50, totalBytes: 100 });
    w.reset();
    expect(w.state.publish.uploadProgress).toBeNull();
  });
});

describe("publish-wizard — back() and setSource() clear stale publish state", () => {
  it("back() from Step 6 (Publish) wipes lastBuildOutPath and phase", () => {
    const w = createPublishWizard();
    w.state.currentStep = 6;
    w.setLastBuildOutPath("C:/tmp/sb-stale.vsk");
    w.setPublishPhase("error", "upload network failed");
    w.setUploadProgress({ bytesUploaded: 1024, totalBytes: 10240 });
    w.back();
    expect(w.state.currentStep).toBe(5);
    expect(w.state.publish.lastBuildOutPath).toBeNull();
    expect(w.state.publish.phase).toBe("idle");
    expect(w.state.publish.error).toBeNull();
    expect(w.state.publish.uploadProgress).toBeNull();
  });

  it("back() from Step 5 (PL/SQL Review) wipes plsql discovery state", () => {
    const w = createPublishWizard();
    w.state.currentStep = 5;
    w.setPlsqlDiscovery(
      [{ kind: "PROCEDURE", owner: "HR", name: "P1", refPath: [] }],
      1024,
    );
    w.back();
    expect(w.state.currentStep).toBe(4);
    expect(w.state.plsql.discoveryStatus).toBe("idle");
    expect(w.state.plsql.discovered).toHaveLength(0);
  });

  it("back() from Step 4 does NOT wipe publish state (different leave clause)", () => {
    const w = createPublishWizard();
    w.state.currentStep = 4;
    // Step 4 back-out clears review state but should leave publish.* alone.
    w.setLastBuildOutPath("C:/tmp/sb-keep.vsk");
    w.setPublishPhase("error", "x");
    w.back();
    expect(w.state.publish.lastBuildOutPath).toBe("C:/tmp/sb-keep.vsk");
    expect(w.state.publish.phase).toBe("error");
  });

  it("setSource() with a different connection wipes publish state", () => {
    const w = createPublishWizard();
    w.setSource("conn-a", "schema_a", true);
    w.setLastBuildOutPath("C:/tmp/sb-a.vsk");
    w.setPublishPhase("error", "upload failed");
    w.setSource("conn-b", "schema_b", true);
    expect(w.state.publish.lastBuildOutPath).toBeNull();
    expect(w.state.publish.phase).toBe("idle");
    expect(w.state.publish.error).toBeNull();
  });

  it("setSource() with the SAME connection+schema does not wipe publish state", () => {
    const w = createPublishWizard();
    w.setSource("conn-a", "schema_a", true);
    w.setLastBuildOutPath("C:/tmp/sb-a.vsk");
    w.setPublishPhase("error", "transient");
    w.setSource("conn-a", "schema_a", true); // re-confirm
    expect(w.state.publish.lastBuildOutPath).toBe("C:/tmp/sb-a.vsk");
    expect(w.state.publish.phase).toBe("error");
  });

  it("softResetPublish() clears all publish state without touching tables/spec", () => {
    const w = createPublishWizard();
    w.setSource("conn-a", "schema_a", true);
    w.setLastBuildOutPath("C:/tmp/sb-a.vsk");
    w.setPublishPhase("upload");
    w.setSandboxId("sb-123");
    w.appendProgressLine("[09:00:00] starting build");
    w.setUploadProgress({ bytesUploaded: 100, totalBytes: 200 });
    w.softResetPublish();
    expect(w.state.publish.lastBuildOutPath).toBeNull();
    expect(w.state.publish.phase).toBe("idle");
    expect(w.state.publish.sandboxId).toBeNull();
    expect(w.state.publish.progressLines).toEqual([]);
    expect(w.state.publish.uploadProgress).toBeNull();
    // Source survives.
    expect(w.state.source.connectionId).toBe("conn-a");
  });
});
