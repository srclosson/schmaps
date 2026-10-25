#!/usr/bin/env bash
# Build the Schmaps image in-cluster with Kaniko and push it to Harbor.
#
# Flow:
#   1. Ensure namespace + Harbor pull secret exist.
#   2. Create a gzipped tar of the build context, base64 it into a ConfigMap.
#   3. Run a temporary in-cluster HTTP server (busybox httpd) serving the tar.
#   4. Run a Kaniko Job whose initContainer downloads the tar, then builds
#      and pushes harbor.srclos.zone/library/schmaps:{latest,v0.2.80}.
#   5. Tear down the temporary context server.
set -euo pipefail

NS=schmaps
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Optional: pin the kube context. Shared kubeconfigs can have their
# current-context flipped by other tools/agents mid-session, which would
# silently target the wrong cluster.
if [[ -n "${SCHMAPS_KUBE_CONTEXT:-}" ]]; then
  kubectl() { command kubectl --context "$SCHMAPS_KUBE_CONTEXT" "$@"; }
fi

cleanup() {
  echo "==> Tearing down temporary context server"
  kubectl delete -f "$ROOT/k8s/context-server.yaml" --ignore-not-found >/dev/null 2>&1 || true
  kubectl delete configmap schmaps-context-b64 -n "$NS" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Ensuring namespace $NS exists"
kubectl get ns "$NS" >/dev/null 2>&1 || kubectl apply -f "$ROOT/k8s/namespace.yaml"

echo "==> Ensuring harbor-pull-secret exists in $NS"
if ! kubectl get secret harbor-pull-secret -n "$NS" >/dev/null 2>&1; then
  kubectl get secret harbor-pull-secret -n gtky -o yaml \
    | sed 's/namespace: gtky/namespace: schmaps/' \
    | kubectl apply -n "$NS" -f -
else
  echo "    (already present)"
fi

echo "==> Packaging build context (gzipped tar -> base64 ConfigMap)"
tar -C "$ROOT" -czf - Dockerfile package.json server.js public | base64 > /tmp/schmaps-context.b64
# Use create/replace (not apply) to avoid the last-applied-configuration
# annotation, which would exceed the 256 KB annotation limit.
kubectl delete configmap schmaps-context-b64 -n "$NS" --ignore-not-found >/dev/null 2>&1 || true
kubectl create configmap schmaps-context-b64 -n "$NS" \
  --from-file=context.b64=/tmp/schmaps-context.b64
rm -f /tmp/schmaps-context.b64

echo "==> Starting temporary context server"
kubectl apply -f "$ROOT/k8s/context-server.yaml"
kubectl wait --for=condition=Available deploy/schmaps-context -n "$NS" --timeout=120s

echo "==> (Re)creating Kaniko build job"
kubectl delete job schmaps-build -n "$NS" --ignore-not-found
kubectl apply -f "$ROOT/k8s/kaniko-build.yaml"

echo "==> Following build logs"
kubectl logs -n "$NS" -f job/schmaps-build || true

echo "==> Waiting for completion"
if kubectl wait --for=condition=complete job/schmaps-build -n "$NS" --timeout=600s; then
  echo "==> ✅ Build complete: harbor.srclos.zone/library/schmaps:latest"
else
  echo "!! Build failed; recent logs:" >&2
  kubectl logs -n "$NS" job/schmaps-build --tail=60 >&2 || true
  exit 1
fi
