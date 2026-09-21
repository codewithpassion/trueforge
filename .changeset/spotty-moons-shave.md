---
'@truefoundry/trueforge': patch
---

Remote computers: a machine now reports where it keeps its sessions, in `hello.workdir`, and the
server builds every session directory from that instead of deriving one from the run-as user. A
computer whose relay holds no readable `hello` answers offline rather than sending commands for a
path that is not there, and a `hello` the server cannot read closes the socket with code 4400.
