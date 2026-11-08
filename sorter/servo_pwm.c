// servo_pwm.c —— 双舵机驱动（舵机1 硬件PWM GPIO34，舵机2 软件50Hz GPIO71）
//
// 用法:
//   servo_pwm set <1|2|1,2> <on|off|home>
//   servo_pwm show                 # 只打印当前 yaml 配置，不动作
//
// 配置:
//   /root/sorter/servo.yaml（可用环境变量 SERVO_YAML 覆盖）
//   每次调用都会重新读取，改完 yaml 下一次动作立即生效，无需重启。
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sched.h>
#include <errno.h>
#include <lgpio.h>

#define HW_PERIOD_NS   5120000
#define MIN_PERIOD_NS  3000000
#define GPIO_SERVO2    71
#define FRAME_US       20000
#define DEFAULT_YAML   "/root/sorter/servo.yaml"
#define HOLDER_PID_FILE "/tmp/servo2_holder.pid"

typedef struct {
    int s1_home_us, s1_swing_us;
    int s1_continuous;              // 1 = 360°连续旋转舵机（速度控制）
    int s1_stop_us;                 // 连续舵机停止脉宽
    int s1_push_us;                 // 连续舵机推出方向速度
    int s1_return_us;               // 连续舵机回程方向速度
    double s1_push_sec, s1_return_sec;  // 0 = 沿用 ramp_sec
    double s1_ramp_sec;                 // 0 = 沿用 ramp_sec（位置模式推出/回位时长）
    int s1_hold_after;                  // 动作结束后继续保持 home 脉冲（防释放抖动）
    int s2_home_us, s2_swing_us;
    double pre_home_sec, ramp_sec, hold_sec, tail_sec;
    double home_hold_sec;
} ServoCfg;

static char g_pwm_dir[128] = "";
static unsigned g_period_ns = HW_PERIOD_NS;
static int g_pwm_active = 0;

static double clampd(double v, double lo, double hi)
{
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static int clampi(int v, int lo, int hi)
{
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static char *trim(char *s)
{
    while (isspace((unsigned char)*s)) s++;
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = 0;
    return s;
}

static double s1_ramp_sec(const ServoCfg *c);

static void load_config(const char *path, ServoCfg *c)
{
    c->s1_home_us = 2900;
    c->s1_swing_us = 1500;
    c->s1_continuous = 0;
    c->s1_stop_us = 1500;
    c->s1_push_us = 1700;
    c->s1_return_us = 1300;
    c->s1_push_sec = 0.0;
    c->s1_return_sec = 0.0;
    c->s1_ramp_sec = 0.0;
    c->s1_hold_after = 1;
    c->s2_home_us = 2900;
    c->s2_swing_us = 1500;
    c->pre_home_sec = 0.2;
    c->ramp_sec = 1.0;
    c->hold_sec = 1.0;
    c->tail_sec = 0.3;
    c->home_hold_sec = 2.0;

    FILE *f = fopen(path, "r");
    if (!f) {
        fprintf(stderr, "servo: %s 不存在，使用默认值\n", path);
        return;
    }
    char line[256];
    int applied = 0;
    while (fgets(line, sizeof(line), f)) {
        char *hash = strchr(line, '#');
        if (hash) *hash = 0;
        char *colon = strchr(line, ':');
        if (!colon) continue;
        *colon = 0;
        char *k = trim(line);
        char *v = trim(colon + 1);
        if (!*k || !*v) continue;
        if (!strcmp(k, "servo1_home_us")) c->s1_home_us = atoi(v);
        else if (!strcmp(k, "servo1_swing_us")) c->s1_swing_us = atoi(v);
        else if (!strcmp(k, "servo1_mode")) {
            if (!strcmp(v, "continuous") || !strcmp(v, "360")) c->s1_continuous = 1;
            else c->s1_continuous = 0;
        }
        else if (!strcmp(k, "servo1_continuous")) c->s1_continuous = atoi(v) ? 1 : 0;
        else if (!strcmp(k, "servo1_stop_us")) c->s1_stop_us = atoi(v);
        else if (!strcmp(k, "servo1_push_us")) c->s1_push_us = atoi(v);
        else if (!strcmp(k, "servo1_return_us")) c->s1_return_us = atoi(v);
        else if (!strcmp(k, "servo1_push_sec")) c->s1_push_sec = atof(v);
        else if (!strcmp(k, "servo1_return_sec")) c->s1_return_sec = atof(v);
        else if (!strcmp(k, "servo1_ramp_sec")) c->s1_ramp_sec = atof(v);
        else if (!strcmp(k, "servo1_hold_after")) {
            c->s1_hold_after = (v[0] == '0' || v[0] == 'f' || v[0] == 'F') ? 0 : 1;
        }
        else if (!strcmp(k, "servo2_home_us")) c->s2_home_us = atoi(v);
        else if (!strcmp(k, "servo2_swing_us")) c->s2_swing_us = atoi(v);
        else if (!strcmp(k, "pre_home_sec")) c->pre_home_sec = atof(v);
        else if (!strcmp(k, "ramp_sec")) c->ramp_sec = atof(v);
        else if (!strcmp(k, "hold_sec")) c->hold_sec = atof(v);
        else if (!strcmp(k, "tail_sec")) c->tail_sec = atof(v);
        else if (!strcmp(k, "home_hold_sec")) c->home_hold_sec = atof(v);
        else {
            fprintf(stderr, "servo.yaml: 未知键 %s（已忽略）\n", k);
            continue;
        }
        applied++;
    }
    fclose(f);

    c->s1_home_us = clampi(c->s1_home_us, 500, 3000);
    c->s1_swing_us = clampi(c->s1_swing_us, 500, 3000);
    c->s1_stop_us = clampi(c->s1_stop_us, 500, 3000);
    c->s1_push_us = clampi(c->s1_push_us, 500, 3000);
    c->s1_return_us = clampi(c->s1_return_us, 500, 3000);
    c->s1_push_sec = clampd(c->s1_push_sec, 0.0, 5.0);
    c->s1_return_sec = clampd(c->s1_return_sec, 0.0, 5.0);
    c->s1_ramp_sec = clampd(c->s1_ramp_sec, 0.0, 5.0);
    c->s2_home_us = clampi(c->s2_home_us, 500, 3000);
    c->s2_swing_us = clampi(c->s2_swing_us, 500, 3000);
    c->pre_home_sec = clampd(c->pre_home_sec, 0.0, 2.0);
    c->ramp_sec = clampd(c->ramp_sec, 0.05, 5.0);
    c->hold_sec = clampd(c->hold_sec, 0.0, 5.0);
    c->tail_sec = clampd(c->tail_sec, 0.0, 2.0);
    c->home_hold_sec = clampd(c->home_hold_sec, 0.2, 5.0);

    if (c->s1_continuous) {
        if (abs(c->s1_stop_us - 1500) > 100) {
            fprintf(stderr,
                    "servo.yaml 警告: servo1_stop_us=%d 偏离 1500 较多，可能不是真正停止点；"
                    "可用 pulse 命令校准（例如 pulse 1 1500 2）\n",
                    c->s1_stop_us);
        }
        if (c->s1_push_us == c->s1_stop_us || c->s1_return_us == c->s1_stop_us ||
            (c->s1_push_us - c->s1_stop_us) * (c->s1_return_us - c->s1_stop_us) >= 0) {
            fprintf(stderr,
                    "servo.yaml 警告: push/return 应位于 stop 两侧，"
                    "例如 stop=1500, push=1200, return=1800\n");
        }
    }

    fprintf(stderr,
            "servo.yaml: %d 项 servo1=%s %d/%d us ramp1=%.2f servo2=%d/%d us "
            "pre=%.2f ramp=%.2f hold=%.2f tail=%.2f home=%.2f\n",
            applied, c->s1_continuous ? "continuous" : "position",
            c->s1_continuous ? c->s1_push_us : c->s1_home_us,
            c->s1_continuous ? c->s1_return_us : c->s1_swing_us,
            s1_ramp_sec(c), c->s2_home_us, c->s2_swing_us,
            c->pre_home_sec, c->ramp_sec, c->hold_sec, c->tail_sec, c->home_hold_sec);
}

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

static int read_file_int(const char *path, int *out)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -1;
    char buf[32] = {0};
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0) return -1;
    *out = atoi(buf);
    return 0;
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

        // 通道已启用：直接沿用，不断开脉冲（避免舵机释放抖动）
        char en_path[160], per_path[160];
        snprintf(en_path, sizeof(en_path), "%s/enable", dir);
        snprintf(per_path, sizeof(per_path), "%s/period", dir);
        int en = 0, per = 0;
        if (read_file_int(en_path, &en) == 0 && en == 1 &&
            read_file_int(per_path, &per) == 0 && per >= (int)MIN_PERIOD_NS) {
            g_period_ns = (unsigned)per;
            snprintf(g_pwm_dir, sizeof(g_pwm_dir), "%s", dir);
            g_pwm_active = 1;
            fprintf(stderr, "pwm: using %s period=%uns (already enabled)\n", dir, g_period_ns);
            return 0;
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
            fprintf(stderr, "pwm: %s cannot set period\n", dir);
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
    if (g_pwm_active) {
        return 0;   // 已处于输出状态：不要断开脉冲，避免舵机释放抖动
    }
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
    g_pwm_active = 1;
}

static void hw_release(void)
{
    char path[160];
    if (g_pwm_dir[0] == 0) return;
    snprintf(path, sizeof(path), "%s/enable", g_pwm_dir);
    write_file_quiet(path, "0");
    g_pwm_active = 0;
}

static int pulse_at_us(double t, int home, int swing, const ServoCfg *c, double ramp_sec)
{
    const double p = c->pre_home_sec;
    const double r = ramp_sec;
    const double h = c->hold_sec;
    if (t < p) return home;
    if (t < p + r) {
        double f = (t - p) / r;
        return (int)(home + (swing - home) * f + 0.5);
    }
    if (t < p + r + h) return swing;
    if (t < p + r + h + r) {
        double f = (t - p - r - h) / r;
        return (int)(swing + (home - swing) * f + 0.5);
    }
    return home;
}

static int s1_idle_us(const ServoCfg *c)
{
    return c->s1_continuous ? c->s1_stop_us : c->s1_home_us;
}

static double s1_push_sec(const ServoCfg *c)
{
    return c->s1_push_sec > 0 ? c->s1_push_sec : c->ramp_sec;
}

static double s1_return_sec(const ServoCfg *c)
{
    return c->s1_return_sec > 0 ? c->s1_return_sec : c->ramp_sec;
}

static double s1_ramp_sec(const ServoCfg *c)
{
    return c->s1_ramp_sec > 0 ? c->s1_ramp_sec : c->ramp_sec;
}

// 360°连续旋转舵机：脉宽控制速度和方向，中位停止；靠“转 time 秒”得到摆幅
static int pulse_s1_at_us(double t, const ServoCfg *c)
{
    if (!c->s1_continuous) {
        return pulse_at_us(t, c->s1_home_us, c->s1_swing_us, c, s1_ramp_sec(c));
    }
    const double p = c->pre_home_sec;
    const double out = s1_push_sec(c);
    const double back = s1_return_sec(c);
    const double h = c->hold_sec;
    if (t < p) return c->s1_stop_us;
    if (t < p + out) return c->s1_push_us;
    if (t < p + out + h) return c->s1_stop_us;
    if (t < p + out + h + back) return c->s1_return_us;
    return c->s1_stop_us;
}

static int duration_on_ms(const ServoCfg *c, int want1, int want2)
{
    double d = 0.0;
    if (want1) {
        double d1 = c->s1_continuous
                        ? c->pre_home_sec + s1_push_sec(c) + c->hold_sec +
                              s1_return_sec(c) + c->tail_sec
                        : c->pre_home_sec + 2 * s1_ramp_sec(c) + c->hold_sec + c->tail_sec;
        if (d1 > d) d = d1;
    }
    if (want2) {
        double d2 = c->pre_home_sec + 2 * c->ramp_sec + c->hold_sec + c->tail_sec;
        if (d2 > d) d = d2;
    }
    return (int)(d * 1000 + 0.5);
}

static volatile sig_atomic_t g_holder_stop = 0;

static void holder_on_signal(int sig)
{
    (void)sig;
    g_holder_stop = 1;
}

// 结束上一次动作留下的 servo2 home 保持进程（若有）
static void stop_holder(void)
{
    FILE *f = fopen(HOLDER_PID_FILE, "r");
    if (!f) return;
    int pid = 0;
    if (fscanf(f, "%d", &pid) != 1) pid = 0;
    fclose(f);
    if (pid > 0 && pid != getpid()) {
        kill(pid, SIGTERM);
        for (int i = 0; i < 100; i++) {
            if (kill(pid, 0) != 0) break;
            usleep(10000);
        }
    }
    unlink(HOLDER_PID_FILE);
}

// 子进程：动作结束后持续输出 servo2 的 home 脉冲，避免信号线悬空和掉力
static void servo2_holder_run(int h, int home_us)
{
    setsid();
    const int devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
        dup2(devnull, 0);
        dup2(devnull, 1);
        dup2(devnull, 2);
        if (devnull > 2) close(devnull);
    }
    // 关闭从父进程继承的无关描述符（尤其是摄像头 /dev/video20），只保留 GPIO 句柄
    for (int fd = 3; fd < 4096; ++fd) {
        if (fd != h) close(fd);
    }
    FILE *f = fopen(HOLDER_PID_FILE, "w");
    if (f) {
        fprintf(f, "%d\n", (int)getpid());
        fclose(f);
    }
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = holder_on_signal;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    setup_rt();

    const int low_us = (FRAME_US > home_us + 1000) ? (FRAME_US - home_us) : 1000;
    while (!g_holder_stop) {
        const long long fs = now_ns();
        lgGpioWrite(h, GPIO_SERVO2, 1);
        const long long hi = fs + (long long)home_us * 1000LL;
        while (now_ns() < hi) {
            if (g_holder_stop) break;
        }
        lgGpioWrite(h, GPIO_SERVO2, 0);
        if (g_holder_stop) break;
        usleep(low_us);
    }
    lgGpioWrite(h, GPIO_SERVO2, 0);
    lgGpioFree(h, GPIO_SERVO2);
    lgGpiochipClose(h);
    unlink(HOLDER_PID_FILE);
    _exit(0);
}

static int run_motion(int want1, int want2, int duration_ms, int home_only,
                      const ServoCfg *c)
{
    int h = -1;
    if (want2) {
        stop_holder();   // 结束上一次动作留下的 home 保持进程
        h = lgGpiochipOpen(0);
        if (h < 0) {
            fprintf(stderr, "gpiochip_open failed\n");
            return -1;
        }
        int claimed = 0;
        for (int i = 0; i < 50; i++) {
            if (lgGpioClaimOutput(h, 0, GPIO_SERVO2, 0) == 0) {
                claimed = 1;
                break;
            }
            usleep(20000);
        }
        if (!claimed) {
            fprintf(stderr, "gpio claim failed\n");
            lgGpiochipClose(h);
            return -1;
        }
    }
    if (want1) {
        if (hw_init() != 0) {
            fprintf(stderr, "hardware pwm init failed\n");
            if (want2) {
                lgGpioFree(h, GPIO_SERVO2);
                lgGpiochipClose(h);
            }
            return -1;
        }
        if (hw_set_duty_us(s1_idle_us(c)) != 0) {
            fprintf(stderr, "set duty failed\n");
            if (want2) {
                lgGpioFree(h, GPIO_SERVO2);
                lgGpiochipClose(h);
            }
            return -1;
        }
        hw_enable();
    }

    int frames = duration_ms * 1000 / FRAME_US;
    long long t0 = now_ns();
    for (int i = 0; i < frames; i++) {
        double t = (double)i * FRAME_US / 1000000.0;
        int us1 = want1 ? (home_only ? s1_idle_us(c) : pulse_s1_at_us(t, c)) : 0;
        int us2 = want2 ? (home_only ? c->s2_home_us
                                     : pulse_at_us(t, c->s2_home_us, c->s2_swing_us, c, c->ramp_sec))
                        : 0;
        if (want1) hw_set_duty_us(us1);
        if (want2) {
            long long fs = t0 + (long long)i * FRAME_US * 1000LL;
            while (now_ns() < fs) { }
            lgGpioWrite(h, GPIO_SERVO2, 1);
            long long hi = fs + (long long)us2 * 1000LL;
            while (now_ns() < hi) { }
            lgGpioWrite(h, GPIO_SERVO2, 0);
        } else {
            usleep(FRAME_US);
        }
    }

    if (want1) {
        if (c->s1_continuous || !c->s1_hold_after) {
            hw_release();
        }
        // 位置模式且 hold_after=1：保持输出 home 脉冲，避免断电后舵机乱转
    }
    if (want2) {
        const pid_t pid = fork();
        if (pid == 0) {
            servo2_holder_run(h, c->s2_home_us);   // 子进程常驻保持 home
        } else if (pid > 0) {
            // 父进程不释放 GPIO71，交给 holder 子进程继续保持
        } else {
            lgGpioWrite(h, GPIO_SERVO2, 0);
            lgGpioFree(h, GPIO_SERVO2);
            lgGpiochipClose(h);
        }
    }
    return 0;
}

static void release_gpio2(void)
{
    stop_holder();
    int h = lgGpiochipOpen(0);
    if (h < 0) return;
    for (int i = 0; i < 50; i++) {
        if (lgGpioClaimOutput(h, 0, GPIO_SERVO2, 0) == 0) {
            lgGpioWrite(h, GPIO_SERVO2, 0);
            lgGpioFree(h, GPIO_SERVO2);
            break;
        }
        usleep(20000);
    }
    lgGpiochipClose(h);
}

// 固定脉宽保持，用于校准 360° 舵机的停止点
static int hold_pulse(int id, int us, double sec)
{
    if (id == 1) {
        if (hw_init() != 0) return -1;
        if (hw_set_duty_us(us) != 0) return -1;
        hw_enable();
        usleep((useconds_t)(sec * 1000000.0));
        hw_release();
        return 0;
    }
    stop_holder();
    int h = lgGpiochipOpen(0);
    if (h < 0) return -1;
    int claimed = 0;
    for (int i = 0; i < 50; i++) {
        if (lgGpioClaimOutput(h, 0, GPIO_SERVO2, 0) == 0) {
            claimed = 1;
            break;
        }
        usleep(20000);
    }
    if (!claimed) {
        lgGpiochipClose(h);
        return -1;
    }
    int frames = (int)(sec * 1000000.0 / FRAME_US);
    long long t0 = now_ns();
    for (int i = 0; i < frames; i++) {
        long long fs = t0 + (long long)i * FRAME_US * 1000LL;
        while (now_ns() < fs) { }
        lgGpioWrite(h, GPIO_SERVO2, 1);
        long long hi = fs + (long long)us * 1000LL;
        while (now_ns() < hi) { }
        lgGpioWrite(h, GPIO_SERVO2, 0);
    }
    lgGpioWrite(h, GPIO_SERVO2, 0);
    lgGpioFree(h, GPIO_SERVO2);
    lgGpiochipClose(h);
    return 0;
}

static void usage(void)
{
    fprintf(stderr, "usage: servo_pwm set <1|2|1,2> <on|off|home> | show\n");
    fprintf(stderr, "       servo_pwm pulse <1|2> <us> <sec>   # 固定脉宽校准停止点\n");
    fprintf(stderr, "  servo 1 = pin32 GPIO34 hardware PWM\n");
    fprintf(stderr, "  servo 2 = GPIO71 busy-wait PWM 50Hz\n");
    fprintf(stderr, "  配置: %s\n", DEFAULT_YAML);
}

int main(int argc, char **argv)
{
    char *args[8];
    int n = 0;
    for (int i = 1; i < argc && n < 8; i++) {
        if (strcmp(argv[i], "--") == 0) continue;
        args[n++] = argv[i];
    }

    const char *yaml = getenv("SERVO_YAML");
    if (!yaml || !*yaml) yaml = DEFAULT_YAML;
    ServoCfg cfg;
    load_config(yaml, &cfg);

    if (n >= 1 && strcmp(args[0], "show") == 0) {
        printf("servo1_mode: %s\n", cfg.s1_continuous ? "continuous" : "position");
        printf("servo1_home_us: %d\n", cfg.s1_home_us);
        printf("servo1_swing_us: %d\n", cfg.s1_swing_us);
        printf("servo1_stop_us: %d\n", cfg.s1_stop_us);
        printf("servo1_push_us: %d\n", cfg.s1_push_us);
        printf("servo1_return_us: %d\n", cfg.s1_return_us);
        printf("servo1_push_sec: %.2f\n", cfg.s1_push_sec);
        printf("servo1_return_sec: %.2f\n", cfg.s1_return_sec);
        printf("servo1_ramp_sec: %.2f\n", cfg.s1_ramp_sec);
        printf("servo1_hold_after: %d\n", cfg.s1_hold_after);
        printf("servo2_home_us: %d\n", cfg.s2_home_us);
        printf("servo2_swing_us: %d\n", cfg.s2_swing_us);
        printf("pre_home_sec: %.2f\n", cfg.pre_home_sec);
        printf("ramp_sec: %.2f\n", cfg.ramp_sec);
        printf("hold_sec: %.2f\n", cfg.hold_sec);
        printf("tail_sec: %.2f\n", cfg.tail_sec);
        printf("home_hold_sec: %.2f\n", cfg.home_hold_sec);
        return 0;
    }

    if (n >= 4 && strcmp(args[0], "pulse") == 0) {
        int id = atoi(args[1]);
        int us = atoi(args[2]);
        double sec = atof(args[3]);
        if ((id != 1 && id != 2) || us < 500 || us > 3000 || sec < 0.1 || sec > 30.0) {
            usage();
            return 2;
        }
        setup_rt();
        if (hold_pulse(id, us, sec) != 0) return 1;
        printf("servo %d: pulse %dus %.1fs done\n", id, us, sec);
        return 0;
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
    if (strcmp(action, "on") != 0 && strcmp(action, "off") != 0 &&
        strcmp(action, "home") != 0) {
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

    int rc = 0;
    if (strcmp(action, "on") == 0) {
        int duration_ms = duration_on_ms(&cfg, want1, want2);
        rc = run_motion(want1, want2, duration_ms, 0, &cfg);
    } else {
        int duration_ms = (int)(cfg.home_hold_sec * 1000 + 0.5);
        rc = run_motion(want1, want2, duration_ms, 1, &cfg);
    }
    if (rc != 0) return 1;
    printf("servo %s: %s done\n", args[1], action);
    return 0;
}
