//! OTLP export to Axiom for the edge relay.
//!
//! Spans are opened per *session*, never per frame. `splice.rs` routes every
//! datagram under a `parking_lot` read guard that deliberately never crosses an
//! await; opening a span there would allocate and lock on the hot path. The
//! `edge.session.splice` span already covers that work in wall-clock terms,
//! which is the right resolution for a blind byte relay.
//!
//! Export runs entirely off the Tokio runtime. `opentelemetry_sdk`'s batch
//! processor uses a dedicated OS thread, and the blocking reqwest client it
//! drives owns its own current-thread runtime, so a slow or unreachable Axiom
//! cannot stall the accept loop.

use std::collections::HashMap;
use std::env;
use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::{KeyValue, global};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{
    LogExporter, MetricExporter, Protocol, SpanExporter, WithExportConfig, WithHttpConfig,
};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{BatchConfigBuilder, BatchSpanProcessor, SdkTracerProvider};
use tracing::level_filters::LevelFilter;
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const SERVICE_NAME: &str = "merkur-edge";
const DEFAULT_ENVIRONMENT: &str = "development";
const SPAN_EXPORT_DELAY: Duration = Duration::from_secs(5);
const METRICS_EXPORT_INTERVAL: Duration = Duration::from_secs(60);
const EXPORT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_QUEUE_SIZE: usize = 2048;
const MAX_EXPORT_BATCH_SIZE: usize = 512;

/// Everything needed to reach Axiom. Built only when `MERKUR_EDGE_OTLP_ENDPOINT`
/// is present; that variable is the master switch.
pub struct TelemetryConfig {
    endpoint: String,
    token: String,
    dataset: String,
    metrics_dataset: Option<String>,
    edge_id: String,
    edge_region: String,
    /// `deployment.environment.name`, matching the server's TELEMETRY_ENVIRONMENT.
    environment: String,
}

/// Provider handles. Dropping them shuts the pipelines down, so `main` must keep
/// this alive for the lifetime of the process.
pub struct Telemetry {
    _tracer: SdkTracerProvider,
    _logger: SdkLoggerProvider,
    meter: Option<SdkMeterProvider>,
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        if let Some(meter) = self.meter.take() {
            let _ = meter.shutdown();
        }
    }
}

pub fn config_from_env(
    edge_id: &str,
    edge_region: &str,
) -> Result<Option<TelemetryConfig>, String> {
    telemetry_config_from_values(
        [
            env::var("MERKUR_EDGE_OTLP_ENDPOINT").ok(),
            env::var("MERKUR_EDGE_OTLP_TOKEN").ok(),
            env::var("MERKUR_EDGE_OTLP_DATASET").ok(),
            env::var("MERKUR_EDGE_OTLP_METRICS_DATASET").ok(),
        ],
        edge_id,
        edge_region,
        env::var("TELEMETRY_ENVIRONMENT").ok(),
    )
}

/// Absent endpoint disables telemetry without consulting anything else; a
/// present endpoint makes token and dataset mandatory, so a half-configured
/// deployment fails at startup instead of running silently unobserved.
fn telemetry_config_from_values(
    values: [Option<String>; 4],
    edge_id: &str,
    edge_region: &str,
    environment: Option<String>,
) -> Result<Option<TelemetryConfig>, String> {
    let [endpoint, token, dataset, metrics_dataset] = values;
    let Some(endpoint) = endpoint else {
        return Ok(None);
    };
    if endpoint.trim().is_empty() {
        return Err("MERKUR_EDGE_OTLP_ENDPOINT must not be empty".to_string());
    }
    let (Some(token), Some(dataset)) = (token, dataset) else {
        return Err(
            "MERKUR_EDGE_OTLP_ENDPOINT requires MERKUR_EDGE_OTLP_TOKEN and MERKUR_EDGE_OTLP_DATASET"
                .to_string(),
        );
    };
    if token.trim().is_empty() || dataset.trim().is_empty() {
        return Err(
            "MERKUR_EDGE_OTLP_TOKEN and MERKUR_EDGE_OTLP_DATASET must not be empty".to_string(),
        );
    }
    let metrics_dataset = match metrics_dataset {
        Some(value) if value.trim().is_empty() => {
            return Err("MERKUR_EDGE_OTLP_METRICS_DATASET must not be empty".to_string());
        }
        other => other,
    };
    Ok(Some(TelemetryConfig {
        endpoint: endpoint.trim_end_matches('/').to_string(),
        token,
        dataset,
        metrics_dataset,
        edge_id: edge_id.to_string(),
        edge_region: edge_region.to_string(),
        environment: environment
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_ENVIRONMENT.to_string()),
    }))
}

/// Release version reported as `service.version`.
///
/// `CARGO_PKG_VERSION` is the edge crate's own version, which is not the
/// Merkur release and never gets bumped — reporting it made the edge show as
/// the crate version next to a release-stamped server version on the same
/// dashboard. `MERKUR_VERSION` is the same variable the server's build stamps
/// in, so both services label themselves identically.
fn service_version() -> String {
    match env::var("MERKUR_VERSION") {
        Ok(version) if !version.trim().is_empty() => version,
        _ => env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn resource(config: &TelemetryConfig) -> Resource {
    let mut attributes = vec![
        KeyValue::new("service.version", service_version()),
        KeyValue::new("deployment.environment.name", config.environment.clone()),
        KeyValue::new("merkur.edge.id", config.edge_id.clone()),
        KeyValue::new("merkur.edge.region", config.edge_region.clone()),
    ];
    if let Ok(alloc) = env::var("FLY_ALLOC_ID") {
        attributes.push(KeyValue::new("fly.alloc.id", alloc));
    }
    if let Ok(machine) = env::var("FLY_MACHINE_ID") {
        attributes.push(KeyValue::new("fly.machine.id", machine));
    }
    Resource::builder()
        .with_service_name(SERVICE_NAME)
        .with_attributes(attributes)
        .build()
}

/// Install the tracing subscriber, and the OTLP pipelines when configured.
///
/// Always initializes the subscriber, so the `fmt` layer keeps `fly logs`
/// working whether or not telemetry is on.
pub fn init(config: Option<TelemetryConfig>) -> Result<Option<Telemetry>, String> {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let Some(config) = config else {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
        return Ok(None);
    };

    let resource = resource(&config);
    // Traces and logs share the dataset header; metrics use their own below.
    let signal_headers: HashMap<String, String> = HashMap::from([
        (
            "authorization".to_string(),
            format!("Bearer {}", config.token),
        ),
        ("x-axiom-dataset".to_string(), config.dataset.clone()),
    ]);

    let span_exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{}/v1/traces", config.endpoint))
        .with_timeout(EXPORT_TIMEOUT)
        .with_headers(signal_headers.clone())
        .build()
        .map_err(|error| format!("otlp span exporter: {error}"))?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_resource(resource.clone())
        .with_span_processor(
            BatchSpanProcessor::builder(span_exporter)
                .with_batch_config(
                    BatchConfigBuilder::default()
                        .with_scheduled_delay(SPAN_EXPORT_DELAY)
                        .with_max_queue_size(MAX_QUEUE_SIZE)
                        .with_max_export_batch_size(MAX_EXPORT_BATCH_SIZE)
                        .build(),
                )
                .build(),
        )
        .build();

    let log_exporter = LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{}/v1/logs", config.endpoint))
        .with_timeout(EXPORT_TIMEOUT)
        .with_headers(signal_headers)
        .build()
        .map_err(|error| format!("otlp log exporter: {error}"))?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_resource(resource.clone())
        .with_batch_exporter(log_exporter)
        .build();

    let meter = match config.metrics_dataset.as_ref() {
        None => None,
        Some(metrics_dataset) => {
            let metric_exporter = MetricExporter::builder()
                .with_http()
                .with_protocol(Protocol::HttpBinary)
                .with_endpoint(format!("{}/v1/metrics", config.endpoint))
                .with_timeout(EXPORT_TIMEOUT)
                .with_headers(HashMap::from([
                    (
                        "authorization".to_string(),
                        format!("Bearer {}", config.token),
                    ),
                    (
                        "x-axiom-metrics-dataset".to_string(),
                        metrics_dataset.clone(),
                    ),
                ]))
                .build()
                .map_err(|error| format!("otlp metric exporter: {error}"))?;
            Some(
                SdkMeterProvider::builder()
                    .with_resource(resource)
                    .with_reader(
                        PeriodicReader::builder(metric_exporter)
                            .with_interval(METRICS_EXPORT_INTERVAL)
                            .build(),
                    )
                    .build(),
            )
        }
    };

    // Only this crate's events become OTLP logs. `internal-logs` makes the SDK
    // emit `tracing` events on export failure; if those fed the log pipeline, a
    // failed export would enqueue a log, which triggers an export, which fails.
    // They still reach the `fmt` layer and `fly logs`.
    let log_bridge = OpenTelemetryTracingBridge::new(&logger_provider)
        .with_filter(Targets::new().with_target("merkur_edge", LevelFilter::INFO));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_opentelemetry::layer().with_tracer(tracer_provider.tracer(SERVICE_NAME)))
        .with(log_bridge)
        .init();

    if let Some(meter) = meter.as_ref() {
        global::set_meter_provider(meter.clone());
    }
    global::set_tracer_provider(tracer_provider.clone());

    Ok(Some(Telemetry {
        _tracer: tracer_provider,
        _logger: logger_provider,
        meter,
    }))
}

#[cfg(all(test, target_os = "macos"))]
#[path = "telemetry_profile.rs"]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;

    fn values(
        endpoint: Option<&str>,
        token: Option<&str>,
        dataset: Option<&str>,
        metrics: Option<&str>,
    ) -> [Option<String>; 4] {
        [
            endpoint.map(str::to_string),
            token.map(str::to_string),
            dataset.map(str::to_string),
            metrics.map(str::to_string),
        ]
    }

    #[test]
    fn absent_endpoint_disables_telemetry() {
        let config = telemetry_config_from_values(
            values(None, Some("token"), Some("dataset"), None),
            "iad-1",
            "iad",
            None,
        )
        .expect("valid");
        assert!(config.is_none());
    }

    #[test]
    fn endpoint_requires_token_and_dataset() {
        for (token, dataset) in [(None, None), (Some("token"), None), (None, Some("dataset"))] {
            assert!(
                telemetry_config_from_values(
                    values(Some("https://api.axiom.co"), token, dataset, None),
                    "iad-1",
                    "iad",
                    None,
                )
                .is_err()
            );
        }
    }

    #[test]
    fn blank_values_are_rejected() {
        for value in [
            values(Some(" "), Some("token"), Some("dataset"), None),
            values(
                Some("https://api.axiom.co"),
                Some(""),
                Some("dataset"),
                None,
            ),
            values(Some("https://api.axiom.co"), Some("token"), Some(" "), None),
            values(
                Some("https://api.axiom.co"),
                Some("token"),
                Some("dataset"),
                Some(""),
            ),
        ] {
            assert!(telemetry_config_from_values(value, "iad-1", "iad", None).is_err());
        }
    }

    #[test]
    fn trailing_slash_is_stripped_so_signal_paths_concatenate() {
        let config = telemetry_config_from_values(
            values(
                Some("https://api.axiom.co/"),
                Some("token"),
                Some("dataset"),
                Some("metrics"),
            ),
            "iad-1",
            "iad",
            None,
        )
        .expect("valid")
        .expect("configured");
        assert_eq!(config.endpoint, "https://api.axiom.co");
        assert_eq!(config.metrics_dataset.as_deref(), Some("metrics"));
        assert_eq!(config.environment, DEFAULT_ENVIRONMENT);
    }

    /// The edge reported no environment at all until this was added, so its
    /// spans could not be separated from a developer's on a shared dashboard.
    #[test]
    fn environment_is_carried_and_blank_falls_back_to_the_default() {
        let complete = values(
            Some("https://api.axiom.co"),
            Some("token"),
            Some("dataset"),
            None,
        );
        let configured = telemetry_config_from_values(
            complete.clone(),
            "iad-1",
            "iad",
            Some("production".into()),
        )
        .expect("valid")
        .expect("configured");
        assert_eq!(configured.environment, "production");

        let blank = telemetry_config_from_values(complete, "iad-1", "iad", Some("   ".into()))
            .expect("valid")
            .expect("configured");
        assert_eq!(blank.environment, DEFAULT_ENVIRONMENT);
    }

    /// Locks the two things Axiom is unforgiving about and that no type check
    /// can catch: traces and metrics go to *different* dataset headers, and the
    /// metrics endpoint accepts only protobuf. Reads the raw bytes off a local
    /// socket rather than trusting the builder's configuration.
    ///
    /// Deliberately not a `#[tokio::test]`: the OTLP exporters use a blocking
    /// reqwest client that owns its own runtime, and dropping that runtime from
    /// inside an async context panics. Both the sink and the exporters run on
    /// plain threads here, which is also how they run in production.
    #[test]
    fn exports_carry_axiom_headers_and_protobuf_metrics() {
        crate::install_crypto_provider();

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind sink");
        let address = listener.local_addr().expect("sink address");
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let sender = tx.clone();
                std::thread::spawn(move || {
                    use std::io::{Read, Write};
                    let mut buffer = vec![0u8; 16384];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
                    let _ = sender.send(String::from_utf8_lossy(&buffer[..read]).to_string());
                });
            }
        });

        let config = telemetry_config_from_values(
            [
                Some(format!("http://{address}")),
                Some("xaat-test".to_string()),
                Some("traces-dataset".to_string()),
                Some("metrics-dataset".to_string()),
            ],
            "iad-1",
            "iad",
            None,
        )
        .expect("valid config")
        .expect("configured");

        let span_exporter = SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(format!("{}/v1/traces", config.endpoint))
            .with_headers(HashMap::from([
                (
                    "authorization".to_string(),
                    format!("Bearer {}", config.token),
                ),
                ("x-axiom-dataset".to_string(), config.dataset.clone()),
            ]))
            .build()
            .expect("span exporter");
        let tracer_provider = SdkTracerProvider::builder()
            .with_resource(resource(&config))
            .with_simple_exporter(span_exporter)
            .build();
        {
            use opentelemetry::trace::Tracer as _;
            tracer_provider
                .tracer(SERVICE_NAME)
                .in_span("edge.session.splice", |_| {});
        }
        tracer_provider.force_flush().expect("flush spans");

        let metric_exporter = MetricExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(format!("{}/v1/metrics", config.endpoint))
            .with_headers(HashMap::from([
                (
                    "authorization".to_string(),
                    format!("Bearer {}", config.token),
                ),
                (
                    "x-axiom-metrics-dataset".to_string(),
                    config.metrics_dataset.clone().expect("metrics dataset"),
                ),
            ]))
            .build()
            .expect("metric exporter");
        let meter_provider = SdkMeterProvider::builder()
            .with_resource(resource(&config))
            .with_periodic_exporter(metric_exporter)
            .build();
        {
            use opentelemetry::metrics::MeterProvider as _;
            meter_provider
                .meter("merkur-edge")
                .u64_counter("merkur_edge_session_attach_total")
                .build()
                .add(1, &[]);
        }
        meter_provider.force_flush().expect("flush metrics");

        let mut traces = None;
        let mut metrics = None;
        for _ in 0..2 {
            let Ok(request) = rx.recv_timeout(Duration::from_secs(10)) else {
                break;
            };
            if request.contains("POST /v1/traces") {
                traces = Some(request);
            } else if request.contains("POST /v1/metrics") {
                metrics = Some(request);
            }
        }

        let traces = traces.expect("traces exported").to_lowercase();
        assert!(
            traces.contains("authorization: bearer xaat-test"),
            "{traces}"
        );
        assert!(
            traces.contains("x-axiom-dataset: traces-dataset"),
            "{traces}"
        );
        assert!(
            traces.contains("content-type: application/x-protobuf"),
            "{traces}"
        );

        let metrics = metrics.expect("metrics exported").to_lowercase();
        assert!(
            metrics.contains("x-axiom-metrics-dataset: metrics-dataset"),
            "{metrics}"
        );
        // The traces dataset header must never ride along on metrics.
        assert!(!metrics.contains("x-axiom-dataset:"), "{metrics}");
        assert!(
            metrics.contains("content-type: application/x-protobuf"),
            "{metrics}"
        );
    }
}
