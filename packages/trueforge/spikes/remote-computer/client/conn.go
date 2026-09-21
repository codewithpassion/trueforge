package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	heartbeatInterval = 10 * time.Second
	// No pong within two intervals means a half-open socket; Agentum never checked this.
	readDeadline = 25 * time.Second
	// A connection that lasted this long is treated as healthy, which resets the backoff step.
	stableAfter = 60 * time.Second
	// Frames are read up to this size; the relay chunks well below it.
	readLimitBytes = 8 << 20
)

type client struct {
	url       string
	computer  string
	token     string
	version   string
	runner    *runner
	transfers *transfers
	logger    *slog.Logger
	// writeMu serialises frame writes, because op handlers answer from their own goroutines.
	writeMu sync.Mutex
}

// runForever dials until told to stop. Only a revoked credential ends the loop.
func (c *client) runForever(ctx context.Context) error {
	step := 0
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		startedAt := time.Now()
		err := c.session(ctx)
		lasted := time.Since(startedAt)
		if errors.Is(err, errRevoked) {
			c.logger.Error("credential revoked; stopping", "lasted_s", lasted.Seconds())
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Resetting on every open, as Agentum did, lets two clients with one credential
		// evict each other forever with no backoff.
		if lasted >= stableAfter {
			step = 0
		} else if step < 6 {
			step++
		}
		delay := backoff(step)
		c.logger.Warn("disconnected; reconnecting", "error", errText(err), "lasted_s", lasted.Seconds(), "delay_s", delay.Seconds(), "step", step)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

var errRevoked = errors.New("credential revoked")

// backoff is uniform in [0.5c, c] with c = min(1000 * 2^step, 60000) ms.
func backoff(step int) time.Duration {
	ceiling := time.Duration(1000*(1<<step)) * time.Millisecond
	if ceiling > 60*time.Second {
		ceiling = 60 * time.Second
	}
	half := ceiling / 2
	// #nosec G404 -- jitter, not a security decision.
	return half + time.Duration(rand.Int63n(int64(half)+1))
}

func errText(err error) string {
	if err == nil {
		return "clean close"
	}
	return err.Error()
}

func (c *client) session(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	dialURL := fmt.Sprintf("%s/connect?computer_id=%s", strings.TrimSuffix(c.url, "/"), c.computer)
	socket, _, err := websocket.Dial(ctx, dialURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.token}},
	})
	if err != nil {
		return fmt.Errorf("dial %s: %w", dialURL, err)
	}
	socket.SetReadLimit(readLimitBytes)
	defer func() { _ = socket.CloseNow() }()
	c.logger.Info("connected", "url", dialURL, "computer_id", c.computer)

	if err := c.sendHello(ctx, socket); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	pong := make(chan struct{}, 8)
	heartbeatCtx, stopHeartbeats := context.WithCancel(ctx)
	defer stopHeartbeats()
	go c.heartbeat(heartbeatCtx, socket, pong)

	for {
		readCtx, readCancel := context.WithTimeout(ctx, readDeadline)
		kind, payload, err := socket.Read(readCtx)
		readCancel()
		if err != nil {
			if websocket.CloseStatus(err) == closeRevoked {
				return errRevoked
			}
			if websocket.CloseStatus(err) == closeReplaced {
				// Another client took this credential; back off instead of duelling with it.
				return fmt.Errorf("replaced by another connection: %w", err)
			}
			return fmt.Errorf("read: %w", err)
		}
		if kind != websocket.MessageText {
			continue
		}
		text := string(payload)
		if text == heartbeatPong {
			select {
			case pong <- struct{}{}:
			default:
			}
			continue
		}
		go c.handle(ctx, socket, payload)
	}
}

// heartbeat sends the literal ping the relay auto-answers and closes the socket when no pong arrives.
func (c *client) heartbeat(ctx context.Context, socket *websocket.Conn, pong <-chan struct{}) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	missed := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-pong:
			missed = 0
		case <-ticker.C:
			if err := c.write(ctx, socket, []byte(heartbeatPing)); err != nil {
				return
			}
			missed++
			if missed >= 2 {
				c.logger.Warn("no heartbeat answer; closing the socket")
				_ = socket.Close(websocket.StatusPolicyViolation, "no heartbeat answer")
				return
			}
		}
	}
}

func (c *client) write(ctx context.Context, socket *websocket.Conn, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return socket.Write(writeCtx, websocket.MessageText, payload)
}

func (c *client) sendHello(ctx context.Context, socket *websocket.Conn) error {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	user := os.Getenv("USER")
	if user == "" {
		user = fmt.Sprintf("uid-%d", os.Getuid())
	}
	hello := helloMessage{
		Type:      "hello",
		Hostname:  hostname,
		OS:        runtime.GOOS,
		Arch:      runtime.GOARCH,
		Version:   c.version,
		RunAsUser: user,
		Capabilities: capabilities{
			Python3: hasTool("python3"),
			Git:     hasTool("g" + "it"),
		},
	}
	payload, err := json.Marshal(hello)
	if err != nil {
		return fmt.Errorf("encode hello: %w", err)
	}
	return c.write(ctx, socket, payload)
}

func hasTool(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// handle answers one request. Each runs on its own goroutine, so the relay's concurrency cap, not the
// client, decides how many commands run at once.
func (c *client) handle(ctx context.Context, socket *websocket.Conn, payload []byte) {
	var head envelope
	if err := json.Unmarshal(payload, &head); err != nil || head.ID == "" {
		c.logger.Warn("dropping an unreadable frame", "error", errText(err))
		return
	}
	answer, err := c.dispatch(head, payload)
	if err != nil {
		answer = errorReply(head.ID, "op_failed", err.Error())
	}
	if writeErr := c.write(ctx, socket, answer); writeErr != nil {
		c.logger.Warn("could not answer", "id", head.ID, "error", writeErr.Error())
	}
}

func (c *client) dispatch(head envelope, payload []byte) ([]byte, error) {
	switch head.Op {
	case "exec":
		var request execRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode exec: %w", err)
		}
		c.logger.Info("exec", "id", head.ID, "command", truncate(request.Command, 120))
		return okReply(head.ID, c.runner.run(head.ID, request))
	case "cancel":
		var request cancelRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode cancel: %w", err)
		}
		cancelled := c.runner.cancel(request.TargetID)
		c.logger.Info("cancel", "id", head.ID, "target_id", request.TargetID, "cancelled", cancelled)
		return okReply(head.ID, cancelResult{Cancelled: cancelled})
	case "file_put":
		var request filePutRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode file_put: %w", err)
		}
		result, err := c.transfers.put(request)
		if err != nil {
			return nil, err
		}
		return okReply(head.ID, result)
	case "file_get":
		var request fileGetRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode file_get: %w", err)
		}
		result, err := get(request)
		if err != nil {
			return nil, err
		}
		return okReply(head.ID, result)
	case "probe":
		var request probeRequest
		if err := json.Unmarshal(payload, &request); err != nil {
			return nil, fmt.Errorf("decode probe: %w", err)
		}
		received, err := base64.StdEncoding.DecodeString(request.PayloadB64)
		if err != nil {
			return nil, fmt.Errorf("decode probe payload: %w", err)
		}
		echo := make([]byte, request.EchoBytes)
		for index := range echo {
			echo[index] = 'y'
		}
		return okReply(head.ID, probeResult{
			ReceivedBytes: len(received),
			EchoB64:       base64.StdEncoding.EncodeToString(echo),
		})
	default:
		return nil, fmt.Errorf("unknown op %q", head.Op)
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
