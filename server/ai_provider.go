package main

// AI provider routing: Claude models go through the Anthropic SDK (askClaude);
// other models (GPT etc.) go through an OpenAI-compatible Chat Completions endpoint,
// which is what most relays (e.g. sub2api) expose.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

// aiBaseURL returns the configured relay root without a trailing "/v1" (both protocols add it themselves).
func aiBaseURL() string {
	b := strings.TrimRight(strings.TrimSpace(getSetting("ai_base_url", "")), "/")
	return strings.TrimSuffix(b, "/v1")
}

func aiModel() string {
	if m := strings.TrimSpace(getSetting("ai_model", "")); m != "" {
		return m
	}
	return defaultModel
}

// aiProvider: "anthropic" or "openai". Setting ai_provider overrides auto-detection by model name.
func aiProvider(model string) string {
	switch getSetting("ai_provider", "") {
	case "anthropic", "openai":
		return getSetting("ai_provider", "")
	}
	if strings.HasPrefix(strings.ToLower(model), "claude") {
		return "anthropic"
	}
	return "openai"
}

// askAI is the single entry point used by every AI feature.
func askAI(ctx context.Context, system, user string) (string, error) {
	if aiProvider(aiModel()) == "anthropic" {
		return askClaude(ctx, system, user)
	}
	return askOpenAI(ctx, system, user)
}

var aiHTTP = &http.Client{Timeout: 3 * time.Minute}

func askOpenAI(ctx context.Context, system, user string) (string, error) {
	key := getSetting("ai_api_key", "")
	if key == "" {
		return "", errors.New("尚未配置 AI API Key（设置 → AI 设置）")
	}
	base := aiBaseURL()
	if base == "" {
		base = "https://api.openai.com"
	}
	body := M{"model": aiModel(), "messages": []M{{"role": "system", "content": system}, {"role": "user", "content": user}}}
	if e := getSetting("ai_effort", ""); e != "" {
		body["reasoning_effort"] = e
	}
	text, status, err := openAIPost(ctx, base+"/v1/chat/completions", key, body)
	if err != nil && status == 400 && body["reasoning_effort"] != nil {
		// not every model accepts reasoning_effort; retry without it
		delete(body, "reasoning_effort")
		text, status, err = openAIPost(ctx, base+"/v1/chat/completions", key, body)
	}
	if err != nil {
		switch status {
		case 401, 403:
			return "", errors.New("AI API Key 无效或无权限")
		case 404:
			return "", errors.New("接口地址或模型不存在：" + err.Error())
		case 429:
			return "", errors.New("AI 请求过于频繁或额度不足，请稍后再试")
		}
		return "", err
	}
	return text, nil
}

func openAIPost(ctx context.Context, url, key string, body M) (string, int, error) {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := aiHTTP.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("AI 请求失败: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
				Refusal string          `json:"refusal"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", resp.StatusCode, fmt.Errorf("AI 服务返回异常 (%d)", resp.StatusCode)
	}
	if resp.StatusCode >= 400 || out.Error != nil {
		msg := fmt.Sprintf("AI 服务错误 (%d)", resp.StatusCode)
		if out.Error != nil && out.Error.Message != "" {
			msg = clip(out.Error.Message, 200)
		}
		return "", resp.StatusCode, errors.New(msg)
	}
	if len(out.Choices) == 0 {
		return "", resp.StatusCode, errors.New("AI 没有返回内容")
	}
	m := out.Choices[0].Message
	if m.Refusal != "" {
		return "", resp.StatusCode, errors.New("AI 拒绝回答该请求")
	}
	// content is usually a string, but some relays return an array of parts
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		return strings.TrimSpace(s), resp.StatusCode, nil
	}
	var parts []struct {
		Text string `json:"text"`
	}
	json.Unmarshal(m.Content, &parts)
	var sb strings.Builder
	for _, p := range parts {
		sb.WriteString(p.Text)
	}
	return strings.TrimSpace(sb.String()), resp.StatusCode, nil
}

// aiModels lists the models a relay offers, trying the OpenAI and Anthropic listing endpoints.
func aiModels(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		BaseURL string `json:"ai_base_url"`
		APIKey  string `json:"ai_api_key"`
	}
	readJSON(r, &req)
	key := strings.TrimSpace(req.APIKey)
	if key == "" {
		key = getSetting("ai_api_key", "")
	}
	if key == "" {
		writeErr(w, 400, "请先填写 API Key")
		return
	}
	base := strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(req.BaseURL), "/"), "/v1")
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	seen := map[string]bool{}
	var errs []string
	// OpenAI style: GET /v1/models with a Bearer key
	oBase := base
	if oBase == "" {
		oBase = "https://api.openai.com"
	}
	if base != "" { // the official Anthropic API is not OpenAI-compatible for listing
		hreq, _ := http.NewRequestWithContext(ctx, "GET", oBase+"/v1/models", nil)
		hreq.Header.Set("Authorization", "Bearer "+key)
		if resp, err := aiHTTP.Do(hreq); err == nil {
			var out struct {
				Data []struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if resp.StatusCode == 200 && json.NewDecoder(resp.Body).Decode(&out) == nil {
				for _, m := range out.Data {
					seen[m.ID] = true
				}
			} else {
				errs = append(errs, fmt.Sprintf("OpenAI 协议 %d", resp.StatusCode))
			}
			resp.Body.Close()
		} else {
			errs = append(errs, "OpenAI 协议连接失败")
		}
	}
	// Anthropic style via the SDK
	opts := []option.RequestOption{option.WithAPIKey(key), option.WithMaxRetries(0)}
	if base != "" {
		opts = append(opts, option.WithBaseURL(base))
	}
	client := anthropic.NewClient(opts...)
	if page, err := client.Models.List(ctx, anthropic.ModelListParams{Limit: anthropic.Int(100)}); err == nil {
		for _, m := range page.Data {
			seen[m.ID] = true
		}
	} else {
		errs = append(errs, "Claude 协议不可用")
	}
	if len(seen) == 0 {
		writeErr(w, 502, "没有获取到模型列表（"+strings.Join(errs, "；")+"），可以直接选择预设模型或手动输入")
		return
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	writeJSON(w, M{"models": ids})
}
