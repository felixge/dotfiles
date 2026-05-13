package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const (
	baseURL = "https://chonk.us1.prod.dog"
	bucket  = "chonk-uploads-prod"
	folder  = "felixge"
)

type uploadResponse struct {
	UploadKey string `json:"uploadKey"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "usage: %s file1 [file2 ... fileN]\n", filepath.Base(os.Args[0]))
		os.Exit(2)
	}

	files := os.Args[1:]
	urls := make([]string, len(files))
	errCh := make(chan error, len(files))
	var wg sync.WaitGroup

	for i, file := range files {
		i, file := i, file
		wg.Add(1)
		go func() {
			defer wg.Done()
			url, err := upload(file)
			if err != nil {
				errCh <- err
				return
			}
			urls[i] = url
		}()
	}

	wg.Wait()
	close(errCh)

	var failed bool
	for err := range errCh {
		failed = true
		fmt.Fprintln(os.Stderr, err)
	}
	if failed {
		os.Exit(1)
	}

	for i, url := range urls {
		fmt.Printf("%s: %s\n", files[i], url)
	}
}

func upload(file string) (string, error) {
	body, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("%s: read: %w", file, err)
	}

	req, err := http.NewRequest(http.MethodPost, baseURL+"/v2/upload/"+folder, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("%s: create request: %w", file, err)
	}
	req.Header.Set("X-BUCKET", bucket)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s: upload: %w", file, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("%s: read response: %w", file, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("%s: upload failed: %s: %s", file, resp.Status, string(respBody))
	}

	var uploadResp uploadResponse
	if err := json.Unmarshal(respBody, &uploadResp); err != nil {
		return "", fmt.Errorf("%s: parse response: %w", file, err)
	}
	if uploadResp.UploadKey == "" {
		return "", fmt.Errorf("%s: response missing uploadKey", file)
	}

	return baseURL + "/v2/get/" + bucket + "/" + uploadResp.UploadKey, nil
}
