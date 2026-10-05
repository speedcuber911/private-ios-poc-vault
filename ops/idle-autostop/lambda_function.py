import datetime
import os

import boto3

REGION = os.environ.get("TARGET_REGION", "ap-south-1")
INSTANCE_IDS = os.environ.get(
    "TARGET_INSTANCE_IDS", "i-0364bb0f31f506e7c,i-05863951ad0263c8e"
).split(",")
CPU_THRESHOLD_PERCENT = float(os.environ.get("CPU_THRESHOLD_PERCENT", "5"))
# bytes per 5-minute period, summed across NetworkIn + NetworkOut
NETWORK_THRESHOLD_BYTES_PER_PERIOD = float(
    os.environ.get("NETWORK_THRESHOLD_BYTES_PER_PERIOD", "2000000")
)
IDLE_WINDOW_MINUTES = int(os.environ.get("IDLE_WINDOW_MINUTES", "120"))
PERIOD_SECONDS = 300
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"
# Set from the Relay app's machine settings; absent means auto-stop is on.
OPT_OUT_TAG = "AutoStopEnabled"

ec2 = boto3.client("ec2", region_name=REGION)
cw = boto3.client("cloudwatch", region_name=REGION)

_METRIC_SPECS = (
    ("cpu", "CPUUtilization", "Maximum"),
    ("netin", "NetworkIn", "Sum"),
    ("netout", "NetworkOut", "Sum"),
)


def lambda_handler(event, context):
    now = datetime.datetime.now(datetime.timezone.utc)
    start = now - datetime.timedelta(minutes=IDLE_WINDOW_MINUTES)
    expected_points = (IDLE_WINDOW_MINUTES * 60) // PERIOD_SECONDS

    resp = ec2.describe_instances(InstanceIds=INSTANCE_IDS)
    instances = [
        inst
        for reservation in resp["Reservations"]
        for inst in reservation["Instances"]
    ]

    def opted_out(inst):
        tags = {t["Key"]: t["Value"] for t in inst.get("Tags", [])}
        return tags.get(OPT_OUT_TAG, "true").strip().lower() == "false"

    # One batched GetMetricData call for every eligible instance, instead of
    # a separate CloudWatch API call per metric per instance.
    queries = []
    for idx, inst in enumerate(instances):
        if inst["State"]["Name"] != "running" or opted_out(inst):
            continue
        for kind, metric_name, stat in _METRIC_SPECS:
            queries.append(
                {
                    "Id": f"{kind}{idx}",
                    "MetricStat": {
                        "Metric": {
                            "Namespace": "AWS/EC2",
                            "MetricName": metric_name,
                            "Dimensions": [
                                {"Name": "InstanceId", "Value": inst["InstanceId"]}
                            ],
                        },
                        "Period": PERIOD_SECONDS,
                        "Stat": stat,
                    },
                    "ReturnData": True,
                }
            )

    metric_results = {}
    if queries:
        data = cw.get_metric_data(
            MetricDataQueries=queries, StartTime=start, EndTime=now
        )
        for r in data["MetricDataResults"]:
            metric_results[r["Id"]] = r

    results = []
    for idx, inst in enumerate(instances):
        instance_id = inst["InstanceId"]
        name_tag = next(
            (t["Value"] for t in inst.get("Tags", []) if t["Key"] == "Name"),
            instance_id,
        )
        state = inst["State"]["Name"]

        if state != "running":
            results.append(f"{name_tag} ({instance_id}): state={state}, skip")
            continue

        if opted_out(inst):
            results.append(f"{name_tag} ({instance_id}): auto-stop turned off ({OPT_OUT_TAG}=false), skip")
            continue

        launch_time = inst["LaunchTime"]
        if (now - launch_time) < datetime.timedelta(minutes=IDLE_WINDOW_MINUTES):
            results.append(
                f"{name_tag} ({instance_id}): launched too recently "
                f"({launch_time.isoformat()}), skip"
            )
            continue

        cpu_r = metric_results.get(f"cpu{idx}", {})
        netin_r = metric_results.get(f"netin{idx}", {})
        netout_r = metric_results.get(f"netout{idx}", {})

        cpu_values = cpu_r.get("Values", [])
        netin_values = netin_r.get("Values", [])
        netout_values = netout_r.get("Values", [])

        if len(cpu_values) < expected_points * 0.8 or len(netin_values) < expected_points * 0.8:
            results.append(
                f"{name_tag} ({instance_id}): insufficient metric coverage "
                f"(cpu={len(cpu_values)}, net_in={len(netin_values)}, "
                f"expected~{expected_points}), skip"
            )
            continue

        max_cpu = max(cpu_values) if cpu_values else 0.0

        combined = {}
        for ts, v in zip(netin_r.get("Timestamps", []), netin_values):
            combined[ts] = combined.get(ts, 0) + v
        for ts, v in zip(netout_r.get("Timestamps", []), netout_values):
            combined[ts] = combined.get(ts, 0) + v
        max_net = max(combined.values()) if combined else 0.0

        idle = max_cpu < CPU_THRESHOLD_PERCENT and max_net < NETWORK_THRESHOLD_BYTES_PER_PERIOD

        if not idle:
            results.append(
                f"{name_tag} ({instance_id}): active "
                f"(max_cpu={max_cpu:.2f}%, max_net/period={max_net / 1e6:.2f}MB), skip"
            )
            continue

        if DRY_RUN:
            results.append(
                f"{name_tag} ({instance_id}): IDLE for {IDLE_WINDOW_MINUTES}min "
                f"(max_cpu={max_cpu:.2f}%, max_net/period={max_net / 1e6:.2f}MB) "
                "-> WOULD STOP (dry run)"
            )
            continue

        ec2.stop_instances(InstanceIds=[instance_id])
        ec2.create_tags(
            Resources=[instance_id],
            Tags=[
                {"Key": "AutoStoppedAt", "Value": now.isoformat()},
                {"Key": "AutoStopReason", "Value": f"idle-{IDLE_WINDOW_MINUTES}min"},
            ],
        )
        results.append(
            f"{name_tag} ({instance_id}): IDLE -> STOPPED "
            f"(max_cpu={max_cpu:.2f}%, max_net/period={max_net / 1e6:.2f}MB)"
        )

    for line in results:
        print(line)

    return {"dry_run": DRY_RUN, "results": results}
