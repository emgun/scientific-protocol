const baseUrl = (process.env.SP_GATEWAY_URL ?? "https://api.scientificprotocol.org").replace(
  /\/+$/u,
  "",
);

async function read(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "application/json", "user-agent": "scientific-protocol-external-agent/0.3" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const [health, claims, work] = await Promise.all([
  read("/health"),
  read("/claims?limit=5&offset=0"),
  read("/work-items?claimable=true&limit=5&offset=0"),
]);

process.stdout.write(
  `${JSON.stringify({
    gateway: baseUrl,
    healthy: health.ok === true,
    claimIds: (claims.items ?? claims).map((claim) => String(claim.claimId)),
    claimableWorkIds: (work.items ?? []).map((item) => String(item.workItemId)),
  })}\n`,
);
