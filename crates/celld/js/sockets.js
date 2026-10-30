// `cloudflare:sockets` -- outbound TCP over the __tcp_* host ops,
// following Workerd (src/workerd/api/sockets.c++): the same address
// parsing (a URL parse behind a fake scheme, so IPv6 works), the same
// validation messages, EOF closing the write side unless allowHalfOpen,
// and startTls() consuming the plaintext socket.
(function () {
  const validHost = (address) => {
    if (address.length === 0 || address.length > 255) return false;
    return /^[a-zA-Z0-9.\-_[\]:]+$/.test(address);
  };

  const parseAddress = (address) => {
    let hostname, port;
    if (typeof address === "string") {
      let url;
      try {
        url = new URL("fake://" + address);
      } catch {
        throw new TypeError("Specified address could not be parsed.");
      }
      if (!url.hostname) {
        throw new TypeError("Specified address is missing hostname.");
      }
      if (!url.port) {
        throw new TypeError("Specified address is missing port.");
      }
      hostname = url.hostname;
      port = Number(url.port);
    } else {
      hostname = String(address?.hostname ?? "");
      if (!hostname) {
        throw new TypeError("Specified address is missing hostname.");
      }
      if (address?.port === undefined || address?.port === null) {
        throw new TypeError("Specified address is missing port.");
      }
      port = Number(address.port);
    }
    const joined = typeof address === "string"
      ? address
      : hostname + ":" + port;
    if (!validHost(joined)) {
      throw new TypeError(
        "Specified address is empty string, contains unsupported " +
          "characters or is too long.");
    }
    return { hostname, port };
  };

  const parseSecureTransport = (options) => {
    const value = options?.secureTransport ?? "off";
    if (value !== "off" && value !== "on" && value !== "starttls") {
      throw new TypeError(
        "Unsupported value in secureTransport socket option: " + value);
    }
    return value;
  };

  // A socket is an I/O object of the request or Durable Object that opened
  // it, as in workerd: its streams refuse every other owner with workerd's
  // error (another object's writes never settle), and `close()` and
  // `startTls()` from another owner leave it alone or are refused by the
  // host. The host id is private, so no value a Worker sets names a
  // connection; the host checks the owner of every id it is handed too.
  const kConstruct = Symbol("Socket");
  const streamIo = __celld.__streamIo;
  // A socket no object refers to any more closes, as in workerd, so an
  // object that opens a connection in each event and drops it holds none
  // of them. The id is the only value held, and a script never sees it.
  const collected = new FinalizationRegistry((id) => __tcp_collect(id));
  const SWEEP_AGAIN = "celld: sweep again";

  class Socket {
    #secureTransport;
    #allowHalfOpen;
    #startTlsInfo; // null once used or unusable
    #id = null;
    #closing = false;
    #detached = false;
    #owner = __ws_owner();
    #opened;
    #closed;
    #resolveClosed;
    #rejectClosed;
    #readable;
    #writable;

    // `refused`: the error every write of this socket rejects with, for the
    // socket another owner's startTls() returns.
    constructor(brand, opening, secureTransport, allowHalfOpen, startTlsInfo,
        refused = null) {
      if (brand !== kConstruct) throw new TypeError("Illegal constructor");
      this.#secureTransport = secureTransport;
      this.#allowHalfOpen = allowHalfOpen;
      this.#startTlsInfo = startTlsInfo;
      this.#closed = new Promise((resolve, reject) => {
        this.#resolveClosed = resolve;
        this.#rejectClosed = reject;
      });
      this.#closed.catch(() => {});

      this.#opened = opening.then((info) => {
        this.#id = info.id;
        collected.register(this, info.id, this);
        // workerd's SocketInfo struct; an outbound socket has no local
        // address (sockets.c++), and the host gives none.
        return __celld.__struct([
          ["remoteAddress", info.remoteAddress ?? undefined, true],
          ["localAddress", undefined, true],
        ]);
      });
      this.#opened.catch(() => {});

      // highWaterMark 0: the stream must never read ahead of the
      // consumer. A speculative host read parked on the connection
      // would deadlock startTls(), whose handshake cannot begin while
      // a plaintext read holds the socket -- the server speaks second.
      this.#readable = new ReadableStream({ __proto__: null,
        pull: async (controller) => {
          await this.#opened;
          if (this.#closing || this.#detached) {
            controller.close();
            return;
          }
          const bytes = await __tcp_read(this.#id);
          if (this.#closing || this.#detached) {
            controller.close();
            return;
          }
          if (bytes.byteLength === 0) {
            controller.close();
            // EOF closes the write side too unless the application
            // asked for a half-open socket.
            if (!this.#allowHalfOpen) await this.#eofClose();
            return;
          }
          controller.enqueue(bytes);
        },
        cancel() {},
      }, { __proto__: null, highWaterMark: 0 });
      this.#writable = new WritableStream({ __proto__: null,
        write: async (chunk) => {
          if (refused !== null) throw refused;
          await this.#opened;
          if (this.#detached) throw new TypeError("This socket was upgraded.");
          const bytes = chunk instanceof Uint8Array
            ? chunk
            : ArrayBuffer.isView(chunk)
              ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
              : new Uint8Array(chunk);
          await __tcp_write(this.#id, bytes);
        },
        close: async () => {
          await this.#opened;
          if (!this.#detached) await __tcp_shutdown(this.#id);
        },
        abort() {},
      });
      // An internal stream, as workerd's socket readable is: one read in
      // flight, and every read checked against the owner first.
      streamIo.internal(this.#readable);
      streamIo.own(this.#readable, "ReadableStreamSource");
      streamIo.own(this.#writable, "Writable", true);

      // A failed connection fails everything the socket exposes.
      opening.catch((error) => {
        this.#closing = true;
        this.#rejectClosed(error);
      });
    }

    get readable() { return this.#readable; }
    get writable() { return this.#writable; }
    get opened() { return this.#opened; }
    get closed() { return this.#closed; }
    get secureTransport() { return this.#secureTransport; }

    async #eofClose() {
      try {
        const writer = this.#writable.getWriter();
        await writer.close();
        writer.releaseLock();
      } catch { /* already closed or locked; closing wins either way */ }
      this.#finishClose();
    }

    #finishClose() {
      if (this.#closing) return;
      this.#closing = true;
      if (this.#id !== null) {
        collected.unregister(this);
        __tcp_close(this.#id);
      }
      this.#resolveClosed(undefined);
    }

    async close() {
      // workerd resolves another owner's close() and the socket stays
      // its owner's.
      if (__ws_owner() !== this.#owner) return;
      if (this.#closing) return this.#closed;
      this.#closing = true;
      try {
        await this.#opened;
      } catch {
        return this.#closed;
      }
      try {
        const writer = this.#writable.getWriter();
        await writer.close();
      } catch { /* stream already closed, errored, or locked */ }
      try {
        await this.#readable.cancel();
      } catch { /* reader may hold the lock; the close below still wins */ }
      collected.unregister(this);
      __tcp_close(this.#id);
      this.#resolveClosed(undefined);
      return this.#closed;
    }

    startTls(options = undefined) {
      if (this.#secureTransport === "on") {
        throw new TypeError("Cannot startTls on a TLS socket.");
      }
      if (this.#secureTransport !== "starttls") {
        throw new TypeError(
          "The `secureTransport` socket option must be set to 'starttls' " +
            "for startTls to be used.");
      }
      if (this.#closing) {
        throw new TypeError(
          "The connection was closed before startTls could be started.");
      }
      if (this.#startTlsInfo === null) {
        throw new TypeError("startTls can only be called once.");
      }
      if (__ws_owner() !== this.#owner) {
        // Nothing of the owner's socket is consumed. As in workerd, its
        // writable is left locked, and the Socket this returns never opens
        // and refuses every write with the readable's I/O error.
        try { this.#writable.getWriter(); } catch { /* already locked */ }
        let refusal;
        try {
          streamIo.check(this.#readable);
        } catch (error) {
          refusal = error;
        }
        return new Socket(kConstruct, new Promise(() => {}), "on",
          this.#allowHalfOpen, null, refusal);
      }
      const info = this.#startTlsInfo;
      this.#startTlsInfo = null;
      this.#detached = true;
      const upgrading = this.#opened.then(async () => {
        const raw = await __tcp_starttls(JSON.stringify({
          id: this.#id,
          host: String(options?.expectedServerHostname ?? info.hostname),
        }));
        // The plaintext socket is consumed; its id now fails every op.
        this.#resolveClosed(undefined);
        const parsed = JSON.parse(raw);
        return { id: parsed.id };
      });
      return new Socket(kConstruct, upgrading, "on", this.#allowHalfOpen, null);
    }
  }

  const connect = (address, options = undefined) => {
    const { hostname, port } = parseAddress(address);
    const secureTransport = parseSecureTransport(options);
    const allowHalfOpen = !!(options && options.allowHalfOpen);
    const request = JSON.stringify({
      hostname,
      port,
      secure: secureTransport === "on",
    });
    // At the socket cap, the host may ask for one more attempt in a later
    // turn, when it can sweep collected sockets again (tcp.rs SWEEP_AGAIN);
    // the second attempt answers the connection or the refusal.
    const opening = __tcp_connect(request, false)
      .catch((error) => {
        if (error?.message !== SWEEP_AGAIN) throw error;
        return __tcp_connect(request, true);
      })
      .then((raw) => JSON.parse(raw));
    return new Socket(
      kConstruct,
      opening,
      secureTransport,
      allowHalfOpen,
      secureTransport === "starttls" ? { hostname } : null,
    );
  };

  __celld.__cfSockets = { connect };
})();
