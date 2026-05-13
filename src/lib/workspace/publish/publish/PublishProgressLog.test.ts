// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { render } from "@testing-library/svelte";
import { describe, it, expect } from "vitest";
import PublishProgressLog from "./PublishProgressLog.svelte";
import { createPublishWizard } from "$lib/stores/publish-wizard.svelte";

describe("PublishProgressLog", () => {
  it("renders empty hint when no lines", () => {
    const w = createPublishWizard();
    const { getByText } = render(PublishProgressLog, { wizard: w });
    expect(getByText(/\(no events yet\)/)).toBeTruthy();
  });

  it("renders each appended line as a separate log row", () => {
    const w = createPublishWizard();
    w.appendProgressLine("starting build");
    w.appendProgressLine("introspecting-schema");
    w.appendProgressLine("done");
    const { container } = render(PublishProgressLog, { wizard: w });
    const lines = container.querySelectorAll(".log-line");
    expect(lines.length).toBe(3);
    expect(lines[0].textContent).toContain("starting build");
    expect(lines[2].textContent).toContain("done");
  });

  it("ring-buffer caps progress lines at 200 (store-level guarantee surfaces in DOM)", () => {
    const w = createPublishWizard();
    for (let i = 0; i < 250; i++) w.appendProgressLine(`line ${i}`);
    expect(w.state.publish.progressLines.length).toBe(200);
    const { container } = render(PublishProgressLog, { wizard: w });
    expect(container.querySelectorAll(".log-line").length).toBe(200);
    expect(container.textContent).toContain("line 249");
    expect(container.textContent).not.toContain("line 49");
  });
});
