# Container image for the Cloudflare Computer sandbox backend.
#
# The base is the release sandbox image, so the userland the agent sees on Workers is the one the
# Node deployments use. `computerd` replaces the entrypoint and mounts the Durable Object's VFS at
# /workspace; supervisor and nats-server stay unstarted because Code Mode reaches the host over the
# container's egress instead.
#
# Both bases are pinned by digest. The computerd tag must equal the `@cloudflare/computer` version
# in package.json and the sandbox tag must equal SANDBOX_IMAGE_URI; a unit test holds both, and the
# digests are re-read when either tag moves.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.0@sha256:70997f6571815ea5779083e078cf2a5e3c0a5913e61cb2cd7c86475a4037f9af AS computerd

FROM tfy.jfrog.io/tfy-images/trueforge-sandbox:0dab475d3d20a8333cff41f25f88e7134c424cf9@sha256:63196eb7c45b75b24e1354d1343eae38698a60fc9f638ee47e8d05c838bbae09

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY computer-entrypoint.sh /usr/local/bin/trueforge-entrypoint
RUN chmod 0555 /usr/local/bin/trueforge-entrypoint

# FUSE_MOUNT=auto takes real FUSE on Cloudflare Containers, where /dev/fuse is exposed, and the
# userspace shim under `wrangler dev`, where it is not. The backend pins PORT to 8080 at launch.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

# The entrypoint installs the CA Cloudflare mints for intercepted HTTPS egress, which only exists
# once the container is running, and then becomes computerd.
ENTRYPOINT ["/usr/local/bin/trueforge-entrypoint"]
