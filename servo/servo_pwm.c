#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sched.h>
#include <errno.h>
#include <lgpio.h>

#define HW_PERIOD_NS  5120000
#define MIN_PERIOD_NS 3000000
#define GPIO_SERVO2   71

#define HOME_US       2900
#define SWING_US      1500
#define PRE_HOME_SEC  0.2
#define RAMP_SEC      1.0
#define HOLD_SEC      1.0
#define TAIL_SEC      0.3
#define FRAME_US      20000
#define ON_DURATION_MS   3500
#define HOME_DURATION_MS 2000

static char g_pwm_dir[128] = "";
static unsigned g_period_ns = HW_PERIOD_NS;

static int write_file_quiet(const char *path, const char *val)
{
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t n = write(fd, val, strlen(val));
    close(fd);
    return (n == (ssize_t)strlen(val)) ? 0 : -1;
}

static int write_file(const char *path, const char *val)
{
    int fd = open(path, O_WRONLY);
    if (fd < 0) {
        fprintf(stderr, "  open %s failed: %s\n", path, strerror(errno));
        return -1;
    }
    errno = 0;
    ssize_t n = write(fd, val, strlen(val));
    if (n != (ssize_t)strlen(val)) {
        fprintf(stderr, "  write %s <- %s failed: %s\n", path, val, strerror(errno));
        close(fd);
        return -1;
    }
    close(fd);
    return 0;
}

static long long now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void setup_rt(void)
{
    struct sched_param sp;
    memset(&sp, 0, sizeof(sp));
    sp.sched_priority = 80;
    sched_setscheduler(0, SCHED_FIFO, &sp);
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(3, &set);
    sched_setaffinity(0, sizeof(set), &set);
}

static int find_pwm(void)
{
    for (int i = 0; i < 8; i++) {
        char chip[64], dir[96], path[128], buf[32];
        snprintf(chip, sizeof(chip), "/sys/class/pwm/pwmchip%d", i);
        if (access(chip, F_OK) != 0) continue;

        snprintf(dir, sizeof(dir), "%s/pwm0", chip);
        if (access(dir, F_OK) != 0) {
            snprintf(path, sizeof(path), "%s/export", chip);
            if (write_file_quiet(path, "0") != 0) {
                fprintf(stderr, "pwm: %s export failed\n", chip);
                continue;
            }
            usleep(150000);
        }
        if (access(dir, F_OK) != 0) {
            fprintf(stderr, "pwm: %s/pwm0 not present after export\n", chip);
            continue;
        }

        snprintf(path, sizeof(path), "%s/enable", dir);
        write_file_quiet(path, "0");
        snprintf(path, sizeof(path), "%s/period", dir);
        int ok = 0;
        for (unsigned p = HW_PERIOD_NS; p >= MIN_PERIOD_NS; p -= 100000) {
            snprintf(buf, sizeof(buf), "%u", p);
            if (write_file_quiet(path, buf) == 0) {
                g_period_ns = p;
                ok = 1;
                break;
            }
        }
        if (!ok) {
            fprintf(stderr, "pwm: %s cannot set period, last error follows:\n", dir);
            snprintf(buf, sizeof(buf), "%u", HW_PERIOD_NS);
            write_file(path, buf);
            continue;
        }
        snprintf(g_pwm_dir, sizeof(g_pwm_dir), "%s", dir);
        fprintf(stderr, "pwm: using %s period=%uns\n", dir, g_period_ns);
        return 0;
    }
    return -1;
}

static int hw_init(void)
{
    char path[160], buf[32];
    if (find_pwm() != 0) {
        fprintf(stderr, "no usable hardware pwm chip found\n");
        return -1;
    }
    /* 先尝试关闭：这颗驱动对已关闭的通道写 0 会返回 EINVAL，属正常现象，忽略 */
    snprintf(path, sizeof(path), "%s/enable", g_pwm_dir);
    write_file_quiet(path, "0");
    snprintf(path, sizeof(path), "%s/period", g_pwm_dir);
    snprintf(buf, sizeof(buf), "%u", g_period_ns);
    if (write_file(path, buf) != 0) return -1;
    return 0;
}

static int hw_set_duty_us(int us)
{
    char path[160], buf[32];
    snprintf(path, sizeof(path), "%s/duty_cycle", g_pwm_dir);
    snprintf(buf, sizeof(buf), "%d", us * 1000);
    return write_file_quiet(path, buf);
}

static void hw_enable(void)
{
    char path[160];
    snprintf(path, sizeof(path), "%s/enable", g_pwm_dir);
    write_file(path, "1");
}

static void hw_release(void)
{
    char path[160];
    if (g_pwm_dir[0] == 0) return;
    snprintf(path, sizeof(path), "%s/enable", g_pwm_dir);
    write_file_quiet(path, "0");
}

static int pulse_at_us(double t)
{
    if (t < PRE_HOME_SEC) return HOME_US;
    if (t < PRE_HOME_SEC + RAMP_SEC) {
        double f = (t - PRE_HOME_SEC) / RAMP_SEC;
        return (int)(HOME_US + (SWING_US - HOME_US) * f + 0.5);
    }
    if (t < PRE_HOME_SEC + RAMP_SEC + HOLD_SEC) return SWING_US;
    if (t < PRE_HOME_SEC + RAMP_SEC + HOLD_SEC + RAMP_SEC) {
        double f = (t - PRE_HOME_SEC - RAMP_SEC - HOLD_SEC) / RAMP_SEC;
        return (int)(SWING_US + (HOME_US - SWING_US) * f + 0.5);
    }
    return HOME_US;
}

static int run_motion(int want1, int want2, int duration_ms, int home_only)
{
    int h = -1;
    if (want2) {
        h = lgGpiochipOpen(0);
        if (h < 0) { fprintf(stderr, "gpiochip_open failed\n"); return -1; }
        if (lgGpioClaimOutput(h, 0, GPIO_SERVO2, 0) < 0) {
            fprintf(stderr, "gpio claim failed\n");
            lgGpiochipClose(h);
            return -1;
        }
    }
    int frames = duration_ms * 1000 / FRAME_US;
    long long t0 = now_ns();
    for (int i = 0; i < frames; i++) {
        double t = (double)i * FRAME_US / 1000000.0;
        int us = home_only ? HOME_US : pulse_at_us(t);
        if (want1) hw_set_duty_us(us);
        if (want2) {
            long long fs = t0 + (long long)i * FRAME_US * 1000LL;
            while (now_ns() < fs) { }
            lgGpioWrite(h, GPIO_SERVO2, 1);
            long long hi = fs + (long long)us * 1000LL;
            while (now_ns() < hi) { }
            lgGpioWrite(h, GPIO_SERVO2, 0);
        } else if (!want1) {
            usleep(FRAME_US);
        } else {
            usleep(FRAME_US);
        }
    }
    if (want2) {
        lgGpioWrite(h, GPIO_SERVO2, 0);
        lgGpioFree(h, GPIO_SERVO2);
        lgGpiochipClose(h);
    }
    return 0;
}

static void release_gpio2(void)
{
    int h = lgGpiochipOpen(0);
    if (h < 0) return;
    if (lgGpioClaimOutput(h, 0, GPIO_SERVO2, 0) == 0) {
        lgGpioWrite(h, GPIO_SERVO2, 0);
        lgGpioFree(h, GPIO_SERVO2);
    }
    lgGpiochipClose(h);
}

static void usage(void)
{
    fprintf(stderr, "usage: servo_pwm set <1|2|1,2> <on|off|home>\n");
    fprintf(stderr, "  servo 1 = pin32 GPIO34 hardware PWM\n");
    fprintf(stderr, "  servo 2 = GPIO71 busy-wait PWM 50Hz\n");
}

int main(int argc, char **argv)
{
    char *args[8];
    int n = 0;
    for (int i = 1; i < argc && n < 8; i++) {
        if (strcmp(argv[i], "--") == 0) continue;
        args[n++] = argv[i];
    }
    if (n < 3 || strcmp(args[0], "set") != 0) { usage(); return 2; }

    int want1 = 0, want2 = 0;
    char ids[64];
    snprintf(ids, sizeof(ids), "%s", args[1]);
    char *save = NULL;
    for (char *tok = strtok_r(ids, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
        if (strcmp(tok, "1") == 0) want1 = 1;
        else if (strcmp(tok, "2") == 0) want2 = 1;
        else { usage(); return 2; }
    }
    if (!want1 && !want2) { usage(); return 2; }

    const char *action = args[2];
    if (strcmp(action, "on") != 0 && strcmp(action, "off") != 0 && strcmp(action, "home") != 0) {
        usage();
        return 2;
    }

    setup_rt();

    if (strcmp(action, "off") == 0) {
        if (want1) hw_release();
        if (want2) release_gpio2();
        printf("servo %s: released\n", args[1]);
        return 0;
    }

    if (want1) {
        if (hw_init() != 0) {
            fprintf(stderr, "hardware pwm init failed\n");
            return 1;
        }
        if (hw_set_duty_us(HOME_US) != 0) {
            fprintf(stderr, "set duty failed\n");
            return 1;
        }
        hw_enable();
    }

    int rc;
    if (strcmp(action, "on") == 0) {
        rc = run_motion(want1, want2, ON_DURATION_MS, 0);
    } else {
        rc = run_motion(want1, want2, HOME_DURATION_MS, 1);
    }
    if (want1) hw_release();
    if (rc != 0) return 1;
    printf("servo %s: %s done\n", args[1], action);
    return 0;
}
