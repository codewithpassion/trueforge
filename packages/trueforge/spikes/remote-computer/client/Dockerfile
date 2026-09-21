# Spike client image. Two stages so the result carries the static binary and nothing else.
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w" -o /out/spike-client .

# busybox rather than distroless: the spike runs `sh -c`, so the image needs a shell.
FROM busybox:1.37
# Without this the client cannot verify the relay's certificate; busybox ships no trust store.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/spike-client /usr/local/bin/spike-client
RUN adduser -D -u 1000 trueforge
USER 1000:1000
ENV HOME=/tmp
ENTRYPOINT ["/usr/local/bin/spike-client"]
