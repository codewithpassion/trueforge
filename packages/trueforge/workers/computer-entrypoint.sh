#!/bin/sh
# Start trusting the egress CA in the background, then hand over to computerd.
#
# The CA only appears once the Worker has set up outbound interception, which it does after this
# container starts, so waiting for it here would either stall startup or give up too early.
# ComputerDO runs the same helper before a command and logs loudly if the CA is still missing.
set -eu

/usr/local/bin/trueforge-trust-egress-ca 120 &

exec /usr/local/bin/computerd "$@"
