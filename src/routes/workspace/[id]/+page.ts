// Copyright 2022-2026 Geraldo Ferreira Viana Júnior
// Licensed under the Apache License, Version 2.0
// https://github.com/veesker-cloud/veesker-community-edition

import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";
import { resolveWorkspaceSource } from "$lib/workspace/sources/resolve";

export const load: PageLoad = async ({ params }) => {
  const source = await resolveWorkspaceSource(params.id);
  if (!source) throw error(404, "Connection or sandbox not found");

  if (source.meta.kind === "sandbox") {
    if (source.meta.expiresAt && new Date(source.meta.expiresAt).getTime() < Date.now()) {
      throw error(410, "This sandbox has expired");
    }
  }

  return { source };
};
