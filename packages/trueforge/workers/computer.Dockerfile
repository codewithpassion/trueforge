# Container image for the Cloudflare Computer sandbox backend.
#
# The base is the release sandbox image, so the userland the agent sees on Workers is the one the
# Node deployments use. `computerd` replaces the entrypoint and mounts the Durable Object's VFS at
# /workspace; supervisor and nats-server stay unstarted until Code Mode is ported (phase 7c).
#
# The two pins move together: the computerd tag must equal the `@cloudflare/computer` version in
# package.json, and the FROM must equal SANDBOX_IMAGE_URI. A unit test holds both.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.3.0 AS computerd

FROM tfy.jfrog.io/tfy-images/trueforge-sandbox:0dab475d3d20a8333cff41f25f88e7134c424cf9

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# FUSE_MOUNT=auto takes real FUSE on Cloudflare Containers, where /dev/fuse is exposed, and the
# userspace shim under `wrangler dev`, where it is not. The backend pins PORT to 8080 at launch.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
