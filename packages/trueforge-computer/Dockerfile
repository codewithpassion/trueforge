# Two stages, so the result carries the static binary and nothing that built it.
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=0.0.0-docker
ENV CGO_ENABLED=0 GOFLAGS=-buildvcs=false
RUN go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/trueforge-computer ./cmd/trueforge-computer

# busybox rather than distroless: exec runs `sh -c`, so the image needs a shell.
FROM busybox:1.37
# Without a trust store the client cannot verify the server's certificate, and it retries
# forever with textbook backoff, which looks like a network problem and is not.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/trueforge-computer /usr/local/bin/trueforge-computer

RUN adduser -D -u 1000 trueforge \
  && mkdir -p /var/lib/trueforge-computer \
  && chown 1000:1000 /var/lib/trueforge-computer

USER 1000:1000
# HOME points at /tmp so a read-only rootfs with a tmpfs on /tmp still works.
ENV HOME=/tmp \
    TRUEFORGE_STATE_DIR=/var/lib/trueforge-computer
VOLUME ["/var/lib/trueforge-computer"]

# `run` is part of the entrypoint so the copyable command is just --url and --code.
ENTRYPOINT ["/usr/local/bin/trueforge-computer", "run"]
