package main

import (
	"crypto"
	"crypto/x509"
	"encoding/pem"
	"fmt"
)

func pemChain(derCerts [][]byte) []byte {
	var out []byte
	for _, der := range derCerts {
		out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	}
	return out
}

func pemPKCS8(key crypto.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("marshal private key: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}
