#!/bin/sh
# Approved-baseline migration set: 0001-0013 (the hosted production state) + 0017 (sync_status, identity-independent).
# 0014 (lifecycle, UNAPPROVED), 0015 and 0016 (read RPCs) are excluded. Usage: tools/make_baseline.sh /tmp/tf-baseline
set -e
out="${1:-/tmp/tf-baseline}"; rm -rf "$out"; mkdir -p "$out"
for n in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0017; do cp supabase/migrations/${n}_*.sql "$out/"; done
ls "$out"
