use crate::datagram::Datagram;
use crate::datagram::DatagramBatch;
use crate::datagram::DATAGRAM_BATCH_CAPACITY;
use crate::datagram::DATAGRAM_BATCH_MAX_BYTES;
use crate::driver::streams::biremote::StreamBiRemoteH3;
use crate::driver::streams::biremote::StreamBiRemoteWT;
use crate::driver::streams::session::StreamSession;
use crate::driver::streams::uniremote::StreamUniRemoteWT;
use crate::driver::streams::Stream;
use crate::driver::utils::bichannel;
use crate::driver::utils::shared_result;
use crate::driver::utils::SendError;
use crate::driver::utils::SharedResultGet;
use crate::driver::utils::SharedResultSet;
use crate::error::ApplicationClose;
use crate::error::SendDatagramError;
use crate::stream::OpeningBiStream;
use crate::stream::OpeningUniStream;
use crate::SessionId;
use std::future::Future;
use std::task::{Context, Poll, Waker};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tracing::debug;
use tracing::debug_span;
use tracing::instrument;
use tracing::trace;
use tracing::Instrument;
use utils::BiChannelEndpoint;
use wtransport_proto::error::ErrorCode;
use wtransport_proto::frame::Frame;
use wtransport_proto::session::SessionRequest;
use wtransport_proto::settings::Settings;

#[inline(always)]
fn poll_once<F: Future>(future: F) -> Poll<F::Output> {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    future.as_mut().poll(&mut context)
}

#[derive(Clone, Debug)]
pub enum DriverError {
    Proto(ErrorCode),
    ApplicationClosed(ApplicationClose),
    NotConnected,
}

#[derive(Debug)]
pub struct Driver {
    quic_connection: quinn::Connection,
    ready_settings: Mutex<mpsc::Receiver<Settings>>,
    ready_sessions: BiChannelEndpoint<StreamSession>,
    ready_uni_wt_streams: Mutex<mpsc::Receiver<StreamUniRemoteWT>>,
    ready_bi_wt_streams: Mutex<mpsc::Receiver<StreamBiRemoteWT>>,
    /// Serializes readers of the connection's received datagrams, which every session shares.
    datagram_reader: Mutex<()>,
    driver_result: SharedResultGet<DriverError>,
}

impl Driver {
    pub fn init(quic_connection: quinn::Connection) -> Self {
        let ready_settings = mpsc::channel(1);
        let ready_sessions = bichannel(1);
        let ready_uni_wt_streams = mpsc::channel(4);
        let ready_bi_wt_streams = mpsc::channel(1);
        let driver_result = shared_result();

        tokio::spawn(
            worker::Worker::new(
                quic_connection.clone(),
                ready_settings.0,
                ready_sessions.0,
                ready_uni_wt_streams.0,
                ready_bi_wt_streams.0,
                driver_result.0,
            )
            .run()
            .instrument(debug_span!("Driver", quic_id = quic_connection.stable_id())),
        );

        Self {
            quic_connection,
            ready_settings: Mutex::new(ready_settings.1),
            ready_sessions: ready_sessions.1,
            ready_uni_wt_streams: Mutex::new(ready_uni_wt_streams.1),
            ready_bi_wt_streams: Mutex::new(ready_bi_wt_streams.1),
            datagram_reader: Mutex::new(()),
            driver_result: driver_result.1,
        }
    }

    pub async fn accept_settings(&self) -> Result<Settings, DriverError> {
        let mut lock = self.ready_settings.lock().await;

        match lock.recv().await {
            Some(settings) => Ok(settings),
            None => Err(self.result().await),
        }
    }

    pub async fn accept_session(&self) -> Result<StreamSession, DriverError> {
        match self.ready_sessions.recv().await {
            Some(session) => Ok(session),
            None => Err(self.result().await),
        }
    }

    pub async fn open_session(
        &self,
        session_request: SessionRequest,
    ) -> Result<StreamSession, DriverError> {
        let stream = Stream::open_bi(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?
            .upgrade()
            .into_session(session_request);

        Ok(stream)
    }

    pub async fn register_session(&self, stream_session: StreamSession) -> Result<(), DriverError> {
        match self.ready_sessions.send(stream_session).await {
            Ok(()) => Ok(()),
            Err(SendError) => Err(self.result().await),
        }
    }

    pub async fn accept_uni(
        &self,
        session_id: SessionId,
    ) -> Result<StreamUniRemoteWT, DriverError> {
        let mut lock = self.ready_uni_wt_streams.lock().await;

        loop {
            let Some(stream) = lock.recv().await else {
                return Err(self.result().await);
            };

            if stream.session_id() == session_id {
                return Ok(stream);
            }

            debug!(
                "Discarding WT stream (stream_id: {}, session_id: {})",
                stream.id(),
                stream.session_id()
            );

            stream
                .into_stream()
                .stop(ErrorCode::BufferedStreamRejected.to_code())
                .expect("Stream not already stopped");
        }
    }

    pub async fn accept_bi(&self, session_id: SessionId) -> Result<StreamBiRemoteWT, DriverError> {
        let mut lock = self.ready_bi_wt_streams.lock().await;

        loop {
            let Some(stream) = lock.recv().await else {
                return Err(self.result().await);
            };

            if stream.session_id() == session_id {
                return Ok(stream);
            }

            debug!(
                "Discarding WT stream (stream_id: {}, session_id: {})",
                stream.id(),
                stream.session_id()
            );

            stream
                .into_stream()
                .1
                .stop(ErrorCode::BufferedStreamRejected.to_code())
                .expect("Stream not already stopped");
        }
    }

    pub async fn receive_datagram(&self, session_id: SessionId) -> Result<Datagram, DriverError> {
        let mut received = None;
        self.read_session_datagrams(session_id, 1, |datagram| received = Some(datagram))
            .await?;
        Ok(received.expect("a completed read accepted one datagram"))
    }

    /// Select from QUIC's bounded receive storage without draining unmatched lanes.
    pub async fn receive_datagram_matching(
        &self,
        session_id: SessionId,
        mut predicate: impl FnMut(&[u8]) -> bool,
    ) -> Result<Datagram, DriverError> {
        let mut malformed = None;
        let raw = self
            .quic_connection
            .read_datagram_matching(
                |raw| match wtransport_proto::datagram::Datagram::read(raw) {
                    Ok(datagram) => {
                        datagram.qstream_id().into_session_id() == session_id
                            && predicate(datagram.payload())
                    }
                    Err(code) => {
                        malformed = Some(code);
                        true
                    }
                },
            )
            .await
            .map_err(|_| DriverError::NotConnected)?;
        if let Some(code) = malformed {
            self.quic_connection
                .close(utils::varint_w2q(code.to_code()), b"");
            return Err(DriverError::Proto(code));
        }
        Datagram::read(raw).map_err(DriverError::Proto)
    }

    /// Every datagram of `session_id` among those already received, at least one.
    pub async fn receive_datagrams(
        &self,
        session_id: SessionId,
        batch: &mut DatagramBatch,
    ) -> Result<(), DriverError> {
        batch.clear();
        self.read_session_datagrams(session_id, DATAGRAM_BATCH_CAPACITY, |datagram| {
            batch.push(datagram.into_payload())
        })
        .await
    }

    /// Pull up to `capacity` received datagrams straight from QUIC, waiting for the first, and
    /// hand `accept` each that belongs to `session_id`; repeat until one did. Reading here
    /// rather than through the worker keeps a packet's datagrams together: QUIC buffers them
    /// under one hold of its state lock, and one read takes what is buffered.
    async fn read_session_datagrams(
        &self,
        session_id: SessionId,
        capacity: usize,
        mut accept: impl FnMut(Datagram),
    ) -> Result<(), DriverError> {
        let _reader = self.datagram_reader.lock().await;
        let mut raw: [bytes::Bytes; DATAGRAM_BATCH_CAPACITY] = Default::default();
        loop {
            let read = match self
                .quic_connection
                .read_datagrams(&mut raw[..capacity], DATAGRAM_BATCH_MAX_BYTES)
                .await
            {
                Ok(read) => read,
                Err(_) => return Err(self.result().await),
            };
            let mut accepted = false;
            for slot in &mut raw[..read] {
                let datagram = match Datagram::read(std::mem::take(slot)) {
                    Ok(datagram) => datagram,
                    Err(error_code) => {
                        // As the worker ends on any HTTP/3 violation: close with its code.
                        self.quic_connection
                            .close(utils::varint_w2q(error_code.to_code()), b"");
                        return Err(DriverError::Proto(error_code));
                    }
                };
                if datagram.session_id() == session_id {
                    trace!("New incoming datagram (session_id: {})", session_id);
                    accept(datagram);
                    accepted = true;
                } else {
                    debug!(
                        "Incoming datagram discarded (session_id: {})",
                        datagram.session_id()
                    );
                }
            }
            if accepted {
                return Ok(());
            }
        }
    }

    pub async fn open_uni(&self, session_id: SessionId) -> Result<OpeningUniStream, DriverError> {
        let quic_stream = Stream::open_uni(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?;

        Ok(OpeningUniStream::new(session_id, quic_stream))
    }

    pub async fn open_bi(&self, session_id: SessionId) -> Result<OpeningBiStream, DriverError> {
        let quic_stream = Stream::open_bi(&self.quic_connection)
            .await
            .ok_or(DriverError::NotConnected)?;

        Ok(OpeningBiStream::new(session_id, quic_stream))
    }

    pub fn send_datagram(
        &self,
        session_id: SessionId,
        payload: &[u8],
    ) -> Result<(), SendDatagramError> {
        let quic_datagram = Datagram::write(session_id, payload).into_quic_bytes();
        // Poll Quinn's non-dropping send exactly once. Its poll holds Quinn's
        // connection-state mutex across both the capacity check and enqueue,
        // so every cloned WebTransport producer has one linearization point.
        // Pending means the bounded queue is full; dropping the future removes
        // its Notify waiter and preserves every older independent datagram.
        let send = self.quic_connection.send_datagram_wait(quic_datagram);
        match poll_once(send) {
            Poll::Pending => Err(SendDatagramError::Backpressure),
            Poll::Ready(Ok(())) => Ok(()),
            Poll::Ready(Err(quinn::SendDatagramError::UnsupportedByPeer)) => {
                Err(SendDatagramError::UnsupportedByPeer)
            }
            Poll::Ready(Err(quinn::SendDatagramError::Disabled)) => {
                Err(SendDatagramError::Disabled)
            }
            Poll::Ready(Err(quinn::SendDatagramError::TooLarge)) => {
                Err(SendDatagramError::TooLarge)
            }
            Poll::Ready(Err(quinn::SendDatagramError::ConnectionLost(_))) => {
                Err(SendDatagramError::NotConnected)
            }
        }
    }

    async fn result(&self) -> DriverError {
        match self.driver_result.result().await {
            Some(error) => error,
            None => panic!("Driver worker panic!"),
        }
    }

    pub fn send_datagram_owned(
        &self,
        session_id: SessionId,
        payload: bytes::Bytes,
    ) -> Result<(), SendDatagramError> {
        let prefix = wtransport_proto::ids::QStreamId::from_session_id(session_id).into_u64();
        let prefix = quinn::VarInt::from_u64(prefix).expect("quarter-stream ID is a QUIC varint");
        match self
            .quic_connection
            .try_send_datagram_with_prefix(prefix, payload)
        {
            Ok(true) => Ok(()),
            Ok(false) => Err(SendDatagramError::Backpressure),
            Err(quinn::SendDatagramError::UnsupportedByPeer) => {
                Err(SendDatagramError::UnsupportedByPeer)
            }
            Err(quinn::SendDatagramError::Disabled) => Err(SendDatagramError::Disabled),
            Err(quinn::SendDatagramError::TooLarge) => Err(SendDatagramError::TooLarge),
            Err(quinn::SendDatagramError::ConnectionLost(_)) => {
                Err(SendDatagramError::NotConnected)
            }
        }
    }
}

mod worker {
    use super::*;
    use crate::driver::streams::qpack::RemoteQPackDecStream;
    use crate::driver::streams::qpack::RemoteQPackEncStream;
    use crate::driver::streams::settings::LocalSettingsStream;
    use crate::driver::streams::settings::RemoteSettingsStream;
    use crate::driver::streams::uniremote::StreamUniRemoteH3;
    use crate::driver::streams::ProtoReadError;
    use crate::driver::streams::ProtoWriteError;
    use crate::driver::utils::TrySendError;
    use streams::connect::ConnectStream;
    use utils::varint_w2q;
    use wtransport_proto::frame::FrameKind;
    use wtransport_proto::headers::Headers;
    use wtransport_proto::session::HeadersParseError;
    use wtransport_proto::stream_header::StreamHeader;
    use wtransport_proto::stream_header::StreamKind;

    pub struct Worker {
        quic_connection: quinn::Connection,
        ready_settings: mpsc::Sender<Settings>,
        ready_sessions: BiChannelEndpoint<StreamSession>,
        ready_uni_wt_streams: mpsc::Sender<StreamUniRemoteWT>,
        ready_bi_wt_streams: mpsc::Sender<StreamBiRemoteWT>,
        driver_result: SharedResultSet<DriverError>,
        local_settings_stream: LocalSettingsStream,
        remote_settings_stream: RemoteSettingsStream,
        remote_qpack_enc_stream: RemoteQPackEncStream,
        remote_qpack_dec_stream: RemoteQPackDecStream,
        connect_stream: ConnectStream,
    }

    impl Worker {
        pub fn new(
            quic_connection: quinn::Connection,
            ready_settings: mpsc::Sender<Settings>,
            ready_sessions: BiChannelEndpoint<StreamSession>,
            ready_uni_wt_streams: mpsc::Sender<StreamUniRemoteWT>,
            ready_bi_wt_streams: mpsc::Sender<StreamBiRemoteWT>,
            driver_result: SharedResultSet<DriverError>,
        ) -> Self {
            Self {
                quic_connection,
                ready_settings,
                ready_sessions,
                ready_uni_wt_streams,
                ready_bi_wt_streams,
                driver_result,
                local_settings_stream: LocalSettingsStream::empty(),
                remote_settings_stream: RemoteSettingsStream::empty(),
                remote_qpack_enc_stream: RemoteQPackEncStream::empty(),
                remote_qpack_dec_stream: RemoteQPackDecStream::empty(),
                connect_stream: ConnectStream::empty(),
            }
        }

        pub async fn run(mut self) {
            debug!("Started");

            let error = self
                .run_impl()
                .await
                .expect_err("Worker must return an error");

            debug!("Ended with error: {:?}", error);

            match &error {
                DriverError::ApplicationClosed(_) => {
                    // Termination procedure
                    // TODO Reset send sides of all streams with SessionGone error
                    self.quic_connection
                        .close(varint_w2q(ErrorCode::NoError.to_code()), b"");
                }
                DriverError::Proto(error_code) => {
                    self.quic_connection
                        .close(varint_w2q(error_code.to_code()), b"");
                }
                DriverError::NotConnected => (),
            }

            self.driver_result.set(error);
        }

        async fn run_impl(&mut self) -> Result<(), DriverError> {
            let mut remote_settings_watcher = self.remote_settings_stream.subscribe();
            let mut ready_uni_h3_streams = mpsc::channel(4);
            let mut ready_bi_h3_streams = mpsc::channel(1);
            // Own every partial header until classification completes. Dropping
            // the worker cancels readers and queue waiters with their streams.
            let mut classifiers = tokio::task::JoinSet::new();

            self.open_and_send_settings().await?;

            loop {
                // Reap completed classifiers before accepting more streams. A
                // malformed header reports its error directly, without waiting
                // for room in a valid-stream queue or retaining a detached task.
                while let Some(result) = classifiers.try_join_next() {
                    Self::classified(result)?;
                }
                tokio::select! {
                    result = Self::accept_uni(&self.quic_connection,
                                              &ready_uni_h3_streams.0,
                                              &self.ready_uni_wt_streams) => {
                        classifiers.spawn(result?);
                    }

                    result = Self::accept_bi(&self.quic_connection,
                                             &ready_bi_h3_streams.0,
                                             &self.ready_bi_wt_streams) => {
                        classifiers.spawn(result?);
                    }

                    result = classifiers.join_next(), if !classifiers.is_empty() => {
                        Self::classified(result.expect("classifier set is not empty"))?;
                    }

                    uni_h3_stream = ready_uni_h3_streams.1.recv() => {
                        let uni_h3_stream = uni_h3_stream.expect("Sender cannot be dropped")?;
                        self.handle_uni_h3_stream(uni_h3_stream)?;
                    }

                    bi_h3_stream = ready_bi_h3_streams.1.recv() => {
                        let (bi_h3_stream, first_frame) = bi_h3_stream.expect("Sender cannot be dropped")?;
                        self.handle_bi_h3_stream(bi_h3_stream, first_frame)?;
                    }


                    settings = remote_settings_watcher.accept_settings() => {
                        let settings = settings.expect("Channel cannot be dropped");
                        self.handle_remote_settings(settings)?;
                    }

                    stream_session = self.ready_sessions.recv() => {
                        match stream_session {
                            Some(stream_session) => {
                                if self.connect_stream.is_empty() {
                                    self.connect_stream.set_stream(stream_session);
                                }
                            }
                            None => return Err(DriverError::NotConnected),
                        };
                    }

                    error = Self::run_control_streams(&mut self.local_settings_stream,
                                                      &mut self.remote_settings_stream,
                                                      &mut self.remote_qpack_enc_stream,
                                                      &mut self.remote_qpack_dec_stream,
                                                      &mut self.connect_stream) => {
                        return Err(error);
                    }

                    () = self.driver_result.closed() => {
                        return Err(DriverError::NotConnected);
                    }
                }
            }
        }

        fn classified(
            result: Result<Result<(), DriverError>, tokio::task::JoinError>,
        ) -> Result<(), DriverError> {
            match result {
                Ok(result) => result,
                Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
                Err(_) => Err(DriverError::NotConnected),
            }
        }

        async fn open_and_send_settings(&mut self) -> Result<(), DriverError> {
            assert!(self.local_settings_stream.is_empty());

            let stream = match Stream::open_uni(&self.quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?
                .upgrade(StreamHeader::new_control())
                .await
            {
                Ok(h3_stream) => h3_stream,
                Err(ProtoWriteError::NotConnected) => return Err(DriverError::NotConnected),
                Err(ProtoWriteError::Stopped) => {
                    return Err(DriverError::Proto(ErrorCode::ClosedCriticalStream));
                }
            };

            self.local_settings_stream.set_stream(stream);
            self.local_settings_stream.send_settings().await
        }

        async fn accept_uni(
            quic_connection: &quinn::Connection,
            ready_uni_h3_streams: &mpsc::Sender<Result<StreamUniRemoteH3, DriverError>>,
            ready_uni_wt_streams: &mpsc::Sender<StreamUniRemoteWT>,
        ) -> Result<impl Future<Output = Result<(), DriverError>> + Send + 'static, DriverError>
        {
            // An incomplete header must not reserve a completed-stream queue:
            // later streams can already hold the connection's receive credit.
            // Each classifier retains its QUIC stream; advertised stream credit
            // bounds live streams independently of these destination queues.
            let h3_ready = ready_uni_h3_streams.clone();
            let wt_ready = ready_uni_wt_streams.clone();

            let stream_quic = Stream::accept_uni(quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?;

            let stream_id = stream_quic.id();
            debug!("New incoming uni stream ({})", stream_id);

            Ok(async move {
                let stream_h3 = match stream_quic.upgrade().await {
                    Ok(stream_h3) => stream_h3,
                    Err(ProtoReadError::H3(error_code)) => {
                        return Err(DriverError::Proto(error_code));
                    }
                    Err(ProtoReadError::IO(_)) => {
                        return Ok(());
                    }
                };

                let stream_kind = stream_h3.kind();
                debug!("Type: {:?}", stream_kind);

                if matches!(stream_kind, StreamKind::WebTransport) {
                    let stream_wt = stream_h3.upgrade();
                    let _ = wt_ready.send(stream_wt).await;
                } else {
                    let _ = h3_ready.send(Ok(stream_h3)).await;
                }
                Ok(())
            }
            .instrument(debug_span!("Stream", "id={}", stream_id)))
        }

        async fn accept_bi(
            quic_connection: &quinn::Connection,
            ready_bi_h3_streams: &mpsc::Sender<
                Result<(StreamBiRemoteH3, Frame<'static>), DriverError>,
            >,
            ready_bi_wt_streams: &mpsc::Sender<StreamBiRemoteWT>,
        ) -> Result<impl Future<Output = Result<(), DriverError>> + Send + 'static, DriverError>
        {
            // Bidirectional streams carry the ordered routing preface and
            // control channels. Preserve their admission order; graphics data
            // uses the independently classified unidirectional path.
            let h3_slot = ready_bi_h3_streams
                .clone()
                .reserve_owned()
                .await
                .expect("Receiver cannot be dropped");

            let wt_slot = match ready_bi_wt_streams.clone().reserve_owned().await {
                Ok(wt_slot) => wt_slot,
                Err(mpsc::error::SendError(_)) => return Err(DriverError::NotConnected),
            };

            let stream_quic = Stream::accept_bi(quic_connection)
                .await
                .ok_or(DriverError::NotConnected)?;

            let stream_id = stream_quic.id();
            debug!("New incoming bi stream ({})", stream_id);

            Ok(async move {
                let mut stream_h3 = stream_quic.upgrade();

                let frame = loop {
                    match stream_h3.read_frame().await {
                        Ok(frame) => {
                            debug!("Frame kind: {:?}", frame.kind());
                            if !matches!(frame.kind(), FrameKind::Exercise(_)) {
                                break frame;
                            }
                        }
                        Err(ProtoReadError::H3(error_code)) => {
                            h3_slot.send(Err(DriverError::Proto(error_code)));
                            return Ok(());
                        }
                        Err(ProtoReadError::IO(_)) => {
                            return Ok(());
                        }
                    }
                };

                debug!("First frame: {:?}", frame);

                match frame.session_id() {
                    Some(session_id) => {
                        let stream_wt = stream_h3.upgrade(session_id);
                        wt_slot.send(stream_wt);
                    }
                    None => {
                        h3_slot.send(Ok((stream_h3, frame)));
                    }
                }
                Ok(())
            }
            .instrument(debug_span!("Stream", "id={}", stream_id)))
        }

        fn handle_uni_h3_stream(&mut self, stream: StreamUniRemoteH3) -> Result<(), DriverError> {
            match stream.kind() {
                StreamKind::Control => {
                    if !self.remote_settings_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_settings_stream.set_stream(stream);
                }
                StreamKind::QPackEncoder => {
                    if !self.remote_qpack_enc_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_qpack_enc_stream.set_stream(stream);
                }
                StreamKind::QPackDecoder => {
                    if !self.remote_qpack_dec_stream.is_empty() {
                        return Err(DriverError::Proto(ErrorCode::StreamCreation));
                    }

                    self.remote_qpack_dec_stream.set_stream(stream);
                }
                StreamKind::WebTransport => unreachable!(),
                StreamKind::Exercise(_) => {}
            }

            Ok(())
        }

        #[instrument(skip_all, name = "Stream", fields(id = %stream.id()))]
        fn handle_bi_h3_stream(
            &mut self,
            mut stream: StreamBiRemoteH3,
            first_frame: Frame<'static>,
        ) -> Result<(), DriverError> {
            match first_frame.kind() {
                FrameKind::Data => {
                    return Err(DriverError::Proto(ErrorCode::FrameUnexpected));
                }
                FrameKind::Headers => {
                    let headers = match Headers::with_frame(&first_frame) {
                        Ok(headers) => headers,
                        Err(error_code) => return Err(DriverError::Proto(error_code)),
                    };

                    debug!("Headers: {:?}", headers);

                    let stream_session = match SessionRequest::try_from(headers) {
                        Ok(session_request) => stream.into_session(session_request),
                        Err(HeadersParseError::MethodNotConnect) => {
                            stream
                                .stop(ErrorCode::RequestRejected.to_code())
                                .expect("Stream not already stopped");
                            return Ok(());
                        }
                        // TODO(biagio): we might have more granularity with errors
                        Err(_) => {
                            stream
                                .stop(ErrorCode::Message.to_code())
                                .expect("Stream not already stopped");
                            return Ok(());
                        }
                    };

                    match self.ready_sessions.try_send(stream_session) {
                        Ok(()) => {}
                        Err(TrySendError::Full(mut stream)) => {
                            debug!("Discarding session request: sessions queue is full");
                            stream
                                .stop(ErrorCode::RequestRejected.to_code())
                                .expect("Stream not already stopped");
                        }
                        Err(TrySendError::Closed(_)) => return Err(DriverError::NotConnected),
                    }
                }
                FrameKind::Settings => {
                    return Err(DriverError::Proto(ErrorCode::FrameUnexpected));
                }
                FrameKind::WebTransport => unreachable!(),
                FrameKind::Exercise(_) => {}
            }

            Ok(())
        }

        async fn run_control_streams(
            local_settings: &mut LocalSettingsStream,
            remote_settings: &mut RemoteSettingsStream,
            remote_qpack_enc: &mut RemoteQPackEncStream,
            remote_qpack_dec: &mut RemoteQPackDecStream,
            connect_stream: &mut ConnectStream,
        ) -> DriverError {
            tokio::select! {
                error = connect_stream.run() => error,
                error = local_settings.run() => error,
                error = remote_settings.run() => error,
                error = remote_qpack_enc.run() => error,
                error = remote_qpack_dec.run() => error,
            }
        }

        fn handle_remote_settings(&mut self, settings: Settings) -> Result<(), DriverError> {
            debug!("Received: {:?}", settings);

            match self.ready_settings.try_send(settings) {
                Ok(()) => Ok(()),
                Err(mpsc::error::TrySendError::Closed(_)) => Err(DriverError::NotConnected),
                Err(mpsc::error::TrySendError::Full(_)) => {
                    unreachable!("No more than 1 setting frame can be processed")
                }
            }
        }
    }
}

pub(crate) mod streams;
pub(crate) mod utils;

#[cfg(test)]
mod admission_tests {
    use super::poll_once;
    use std::future::{pending, ready};
    use std::hint::black_box;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::task::Poll;
    use std::time::Instant;

    struct CountedPending {
        polls: Arc<AtomicUsize>,
        drops: Arc<AtomicUsize>,
    }

    impl std::future::Future for CountedPending {
        type Output = ();

        fn poll(
            self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
        ) -> Poll<Self::Output> {
            self.polls.fetch_add(1, Ordering::Relaxed);
            Poll::Pending
        }
    }

    impl Drop for CountedPending {
        fn drop(&mut self) {
            self.drops.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn atomic_admission_scaffold_polls_exactly_once() {
        assert_eq!(poll_once(ready(73)), Poll::Ready(73));
        assert_eq!(poll_once(pending::<usize>()), Poll::Pending);

        let polls = Arc::new(AtomicUsize::new(0));
        let drops = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            poll_once(CountedPending {
                polls: Arc::clone(&polls),
                drops: Arc::clone(&drops),
            }),
            Poll::Pending,
        );
        assert_eq!(polls.load(Ordering::Relaxed), 1);
        assert_eq!(drops.load(Ordering::Relaxed), 1);
    }

    #[test]
    #[ignore = "manual release-mode microbenchmark"]
    fn benchmark_single_poll_scaffold_distribution() {
        const SAMPLES: usize = 200;
        const ITERATIONS: usize = 100_000;
        let mut nanos_per_poll = Vec::with_capacity(SAMPLES);
        let mut checksum = 0usize;

        for sample in 0..SAMPLES {
            let started = Instant::now();
            for iteration in 0..ITERATIONS {
                if let Poll::Ready(value) = poll_once(ready(black_box(sample ^ iteration))) {
                    checksum ^= black_box(value);
                }
            }
            nanos_per_poll.push(started.elapsed().as_nanos() as f64 / ITERATIONS as f64);
        }
        nanos_per_poll.sort_by(f64::total_cmp);
        let percentile = |numerator: usize| nanos_per_poll[(SAMPLES - 1) * numerator / 100];
        eprintln!(
            "single-poll scaffold ns/op: median={:.3} p95={:.3} p99={:.3} worst={:.3} checksum={checksum}",
            percentile(50),
            percentile(95),
            percentile(99),
            nanos_per_poll[SAMPLES - 1],
        );
    }
}
